'use strict';

/**
 * orderPolling.service.js
 *
 * Multi-provider Order Status Poller.
 *
 * This service is the authoritative polling engine for PROCESSING orders.
 * It supersedes the single-provider pollProcessingOrders() in
 * orderFulfillment.service.js by adding:
 *
 *   ① Multi-provider awareness — groups orders by their provider before
 *     dispatching adapter calls. A single cron tick handles all providers.
 *
 *   ② Controlled concurrency — processes at most MAX_CONCURRENT_PROVIDERS
 *     providers simultaneously to avoid saturating the event loop.
 *
 *   ③ Batch size limiting — each provider's orders are split into sub-batches
 *     of MAX_BATCH_SIZE entries before being sent to the adapter.
 *
 *   ④ Graceful degradation — a provider API failure never crashes the poller
 *     or affects other providers' processing.
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 *
 *   pollPendingOrders()
 *     │
 *     ├─ 1. Order.find(status=PROCESSING, providerOrderId≠null)  [DB]
 *     │
 *     ├─ 2. Group by provider  (reads Product → ProviderProduct → Provider)
 *     │
 *     ├─ 3. For each provider group (≤ MAX_CONCURRENT_PROVIDERS at once):
 *     │       └─ Split into sub-batches of MAX_BATCH_SIZE
 *     │           └─ adapter.checkOrders(providerOrderIds)
 *     │               └─ processOrderStatusResult(order, statusResult)
 *     │
 *     └─ 4. Return PollStats
 *
 * ─── Design contracts ──────────────────────────────────────────────────────────
 *
 *   - Only orders with status = PROCESSING are touched.
 *   - processOrderStatusResult() is NEVER called on a non-PROCESSING order.
 *   - The poller is fully idempotent — running it twice produces the same result.
 *   - No business logic lives here; order transitions delegate to
 *     orderFulfillment.service.processOrderStatusResult().
 *
 * ─── Environment knobs ────────────────────────────────────────────────────────
 *
 *   POLL_BATCH_LIMIT          Max orders loaded per run        (default 100)
 *   POLL_MAX_BATCH_SIZE       Max orders per adapter call      (default 50)
 *   POLL_MAX_CONCURRENT       Max providers polled in parallel (default 3)
 *   POLL_INTER_BATCH_DELAY_MS Delay between sub-batches, ms   (default 0)
 */

const { Order, ORDER_STATUS } = require('./order.model');
const { processOrderStatusResult } = require('./orderFulfillment.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { Provider } = require('../providers/provider.model');

// ── Configuration (overridable via env for production tuning) ─────────────────

/** Maximum number of PROCESSING orders to load per polling cycle. */
const POLL_BATCH_LIMIT = parseInt(process.env.POLL_BATCH_LIMIT ?? '100', 10);

/** Maximum number of orders sent to a provider in a single checkOrders() call. */
const MAX_BATCH_SIZE = parseInt(process.env.POLL_MAX_BATCH_SIZE ?? '50', 10);

/** Maximum number of providers processed in parallel per cycle. */
const MAX_CONCURRENT_PROVIDERS = parseInt(process.env.POLL_MAX_CONCURRENT ?? '3', 10);

/** Optional delay between sub-batches for the same provider (ms). */
const INTER_BATCH_DELAY_MS = parseInt(process.env.POLL_INTER_BATCH_DELAY_MS ?? '0', 10);

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Split an array into chunks of `size`.
 *
 * @template T
 * @param {T[]}    arr
 * @param {number} size
 * @returns {T[][]}
 */
const chunk = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

/**
 * Sleep for `ms` milliseconds.
 * Used to rate-limit sub-batch calls when INTER_BATCH_DELAY_MS > 0.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Run an array of async thunks with a ceiling of `limit` concurrent promises.
 * Results are returned in the same order as `tasks`; rejections are caught and
 * returned as PromiseSettledResult objects so one failure never aborts others.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number}                  limit
 * @returns {Promise<Array<PromiseSettledResult<T>>>}
 */
const runWithConcurrency = async (tasks, limit) => {
    const results = new Array(tasks.length);
    let index = 0;

    const worker = async () => {
        while (index < tasks.length) {
            const current = index++;
            try {
                results[current] = { status: 'fulfilled', value: await tasks[current]() };
            } catch (err) {
                results[current] = { status: 'rejected', reason: err };
            }
        }
    };

    const workers = Array.from(
        { length: Math.min(limit, tasks.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
};

// =============================================================================
// STEP 2 — GROUP ORDERS BY PROVIDER
// =============================================================================

/**
 * GroupedOrders = Map<providerId_string, { providerDoc, orders[] }>
 *
 * Each entry represents one provider and the PROCESSING orders belonging to it.
 * Orders without a ProviderProduct link (standalone products) go into a
 * dedicated 'NO_PROVIDER' bucket and are skipped by the adapter layer.
 *
 * @param {import('./order.model').Order[]} orders
 * @returns {Promise<Map<string, { providerDoc: Object|null, orders: Object[] }>>}
 */
const groupOrdersByProvider = async (orders) => {
    const groups = new Map();   // providerId → { providerDoc, orders[] }

    // Populate orders with their product + providerProduct chain
    // We use lean() + manual populate to avoid re-fetching the same providers
    // multiple times when many orders share the same provider.
    const providerCache = new Map();   // providerId_string → Provider document

    for (const order of orders) {
        // order.productId is populated (from the find query below)
        const providerProductDoc = order.productId?.providerProduct;
        const providerId = providerProductDoc?.provider
            ? String(providerProductDoc.provider)
            : null;

        if (!providerId) {
            // Standalone product — no provider attached; skip polling
            const key = 'NO_PROVIDER';
            if (!groups.has(key)) {
                groups.set(key, { providerDoc: null, orders: [] });
            }
            groups.get(key).orders.push(order);
            continue;
        }

        if (!groups.has(providerId)) {
            // Fetch provider document (cached per polling cycle)
            let providerDoc = providerCache.get(providerId);
            if (!providerDoc) {
                providerDoc = await Provider.findById(providerId);
                if (providerDoc) providerCache.set(providerId, providerDoc);
            }
            groups.set(providerId, { providerDoc, orders: [] });
        }

        groups.get(providerId).orders.push(order);
    }

    return groups;
};

// =============================================================================
// STEP 3 — POLL A SINGLE PROVIDER GROUP
// =============================================================================

/**
 * PollProviderResult = {
 *   providerId:  string,
 *   checked:     number,
 *   completed:   number,
 *   failed:      number,
 *   pending:     number,
 *   errors:      string[],
 * }
 *
 * @param {string} providerId
 * @param {Object} providerDoc
 * @param {Object[]} orders            - all PROCESSING orders for this provider
 * @returns {Promise<PollProviderResult>}
 */
const pollProviderGroup = async (providerId, providerDoc, orders) => {
    const result = {
        providerId,
        checked: orders.length,
        completed: 0,
        failed: 0,
        pending: 0,
        errors: [],
    };

    if (!providerDoc) {
        // Provider document missing or deleted — skip gracefully
        result.errors.push(`Provider ${providerId} document not found — skipping ${orders.length} order(s).`);
        result.pending = orders.length;
        return result;
    }

    if (!providerDoc.isActive) {
        // Inactive provider — leave orders PROCESSING, retry next cycle
        result.errors.push(`Provider "${providerDoc.name}" is inactive — skipping ${orders.length} order(s).`);
        result.pending = orders.length;
        return result;
    }

    // Resolve the adapter for this provider
    let adapter;
    try {
        adapter = getProviderAdapter(providerDoc);
    } catch (err) {
        result.errors.push(`[adapter] ${err.message}`);
        result.pending = orders.length;
        return result;
    }

    // Build a lookup map: providerOrderId → Order document
    const orderMap = new Map(orders.map((o) => [o.providerOrderId, o]));

    // Split into sub-batches to respect MAX_BATCH_SIZE
    const batches = chunk(orders, MAX_BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const providerOrderIds = batch.map((o) => o.providerOrderId);

        // Optional inter-batch delay (rate limiting)
        if (batchIdx > 0 && INTER_BATCH_DELAY_MS > 0) {
            await sleep(INTER_BATCH_DELAY_MS);
        }

        // Fetch statuses from the provider
        let statusResults;
        try {
            statusResults = await adapter.checkOrders(providerOrderIds);
        } catch (err) {
            const msg = `[checkOrders batch ${batchIdx + 1}/${batches.length}] ${err.message}`;
            result.errors.push(msg);
            console.error(`[OrderPolling] Provider "${providerDoc.name}" ${msg}`);
            // Leave all orders in this batch as PROCESSING for the next cycle
            result.pending += batch.length;
            continue;
        }

        // Build result map: providerOrderId → statusResult
        const resultMap = new Map(
            (statusResults ?? []).map((r) => [r.providerOrderId, r])
        );

        // Process each order in the batch
        for (const order of batch) {
            const statusResult = resultMap.get(order.providerOrderId);

            if (!statusResult) {
                // Provider didn't return status for this order — leave PROCESSING
                result.pending++;
                continue;
            }

            try {
                const { action } = await processOrderStatusResult(order, statusResult);
                if (action === 'completed') result.completed++;
                else if (action === 'failed') result.failed++;
                else result.pending++;   // 'pending' or 'skipped'
            } catch (err) {
                const msg = `[order:${order._id}] ${err.message}`;
                result.errors.push(msg);
                console.error(`[OrderPolling] ${msg}`);
                result.pending++;
            }
        }
    }

    return result;
};

// =============================================================================
// MAIN: pollPendingOrders()
// =============================================================================

/**
 * PollStats = {
 *   checkedOrders:    number,   // total PROCESSING orders found
 *   completed:        number,   // transitioned to COMPLETED
 *   failed:           number,   // transitioned to FAILED (+ refunded)
 *   stillProcessing:  number,   // still PROCESSING (not yet resolved)
 *   skippedOrders:    number,   // no providerOrderId → cannot poll
 *   providerResults:  PollProviderResult[],
 *   errors:           string[], // top-level errors (provider errors live in providerResults)
 *   polledAt:         Date,
 * }
 */

/**
 * pollPendingOrders(options?)
 *
 * Main entry point for the Order Status Poller.
 *
 * Finds all PROCESSING orders with a providerOrderId, groups them by provider,
 * then dispatches adapter.checkOrders() calls in bounded-concurrency batches.
 *
 * Safe to call from any context (cron, admin trigger, test).
 * Fully idempotent — running it twice produces the same outcome.
 *
 * @param {Object}  [options]
 * @param {Object}  [options.adapterOverrides]
 *   Map<providerId_string, adapterInstance> — inject pre-built adapters (tests).
 *   When provided, the factory is bypassed for those providers.
 *
 * @returns {Promise<PollStats>}
 */
const pollPendingOrders = async (options = {}) => {
    const { adapterOverrides = {} } = options;
    const polledAt = new Date();

    const stats = {
        checkedOrders: 0,
        completed: 0,
        failed: 0,
        stillProcessing: 0,
        skippedOrders: 0,
        providerResults: [],
        errors: [],
        polledAt,
    };

    // ── Step 1: Load PROCESSING orders ────────────────────────────────────────
    //
    // Only orders with a providerOrderId can be polled — the adapter needs it
    // to query the provider's API.  Orders without one (e.g. placeOrder failed
    // before the provider assigned an ID) are left alone.
    //
    // Sort by lastCheckedAt ASC so orders that haven't been checked recently
    // are prioritised.  This is a fairness mechanism for large queues.
    //
    let processingOrders;
    try {
        processingOrders = await Order
            .find({
                status: ORDER_STATUS.PROCESSING,
                providerOrderId: { $ne: null },
            })
            .populate({
                path: 'productId',
                select: 'providerProduct',
                populate: {
                    path: 'providerProduct',
                    select: 'provider externalProductId',
                },
            })
            .sort({ lastCheckedAt: 1 })
            .limit(POLL_BATCH_LIMIT);
    } catch (err) {
        stats.errors.push(`[db:find] ${err.message}`);
        console.error('[OrderPolling] Failed to load PROCESSING orders:', err.message);
        return stats;
    }

    if (!processingOrders.length) {
        console.log('[OrderPolling] No PROCESSING orders to poll.');
        return stats;
    }

    stats.checkedOrders = processingOrders.length;
    console.log(`[OrderPolling] Polling ${processingOrders.length} PROCESSING order(s)…`);

    // ── Step 2: Group orders by provider ──────────────────────────────────────
    const groups = await groupOrdersByProvider(processingOrders);

    // ── Step 3: Dispatch per-provider polling with bounded concurrency ─────────

    // Build the task list — one task per provider group, skip 'NO_PROVIDER'
    const tasks = [];
    for (const [providerId, { providerDoc, orders }] of groups.entries()) {
        if (providerId === 'NO_PROVIDER') {
            stats.skippedOrders += orders.length;
            stats.stillProcessing += orders.length;
            continue;
        }

        // Allow tests to inject a pre-built adapter, bypassing the factory
        const injectedAdapter = adapterOverrides[providerId] ?? null;

        tasks.push(async () => {
            if (injectedAdapter) {
                // Use the injected adapter directly — wrap providerDoc minimally
                const fakeProviderDoc = providerDoc ?? {
                    _id: providerId,
                    name: `provider-${providerId}`,
                    isActive: true,
                };

                // Patch the group so pollProviderGroup uses the injected adapter
                // by temporarily overriding getProviderAdapter for this call.
                return pollProviderGroupWithAdapter(
                    providerId,
                    fakeProviderDoc,
                    orders,
                    injectedAdapter
                );
            }
            return pollProviderGroup(providerId, providerDoc, orders);
        });
    }

    const settlements = await runWithConcurrency(tasks, MAX_CONCURRENT_PROVIDERS);

    // ── Step 4: Aggregate results ─────────────────────────────────────────────
    for (const settlement of settlements) {
        if (settlement.status === 'fulfilled') {
            const pr = settlement.value;
            stats.providerResults.push(pr);
            stats.completed += pr.completed;
            stats.failed += pr.failed;
            stats.stillProcessing += pr.pending;
            if (pr.errors.length) {
                stats.errors.push(...pr.errors.map((e) => `[${pr.providerId}] ${e}`));
            }
        } else {
            // Unexpected error escaping pollProviderGroup
            const msg = settlement.reason?.message ?? 'Unknown error';
            stats.errors.push(`[provider] ${msg}`);
            console.error('[OrderPolling] Unexpected provider poll error:', msg);
        }
    }

    console.log(
        `[OrderPolling] Done. ` +
        `checked=${stats.checkedOrders} ` +
        `completed=${stats.completed} ` +
        `failed=${stats.failed} ` +
        `stillProcessing=${stats.stillProcessing} ` +
        `skipped=${stats.skippedOrders} ` +
        `errors=${stats.errors.length}`
    );

    return stats;
};

// =============================================================================
// INTERNAL: pollProviderGroupWithAdapter (injected adapter variant)
// =============================================================================

/**
 * Identical to pollProviderGroup() but accepts a pre-built adapter instance.
 * Used when adapterOverrides are injected (test path).
 *
 * @private
 */
const pollProviderGroupWithAdapter = async (providerId, providerDoc, orders, adapter) => {
    const result = {
        providerId,
        checked: orders.length,
        completed: 0,
        failed: 0,
        pending: 0,
        errors: [],
    };

    const batches = chunk(orders, MAX_BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const providerOrderIds = batch.map((o) => o.providerOrderId);

        if (batchIdx > 0 && INTER_BATCH_DELAY_MS > 0) {
            await sleep(INTER_BATCH_DELAY_MS);
        }

        let statusResults;
        try {
            statusResults = await adapter.checkOrders(providerOrderIds);
        } catch (err) {
            const msg = `[checkOrders batch ${batchIdx + 1}/${batches.length}] ${err.message}`;
            result.errors.push(msg);
            console.error(`[OrderPolling] ${msg}`);
            result.pending += batch.length;
            continue;
        }

        const resultMap = new Map(
            (statusResults ?? []).map((r) => [r.providerOrderId, r])
        );

        for (const order of batch) {
            const statusResult = resultMap.get(order.providerOrderId);
            if (!statusResult) { result.pending++; continue; }

            try {
                const { action } = await processOrderStatusResult(order, statusResult);
                if (action === 'completed') result.completed++;
                else if (action === 'failed') result.failed++;
                else result.pending++;
            } catch (err) {
                result.errors.push(`[order:${order._id}] ${err.message}`);
                result.pending++;
            }
        }
    }

    return result;
};

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    pollPendingOrders,
    // Internal helpers exported for unit testing
    groupOrdersByProvider,
    chunk,
    MAX_BATCH_SIZE,
    MAX_CONCURRENT_PROVIDERS,
    POLL_BATCH_LIMIT,
};
