'use strict';

/**
 * providerProductSync.service.js
 *
 * Dedicated sync engine for Layer 2 (ProviderProducts).
 *
 * Responsibilities:
 *   - Fetch raw product list from provider via adapter.fetchProducts()
 *   - Upsert into provider_products collection (idempotent)
 *   - Mark products not returned in the last sync as inactive
 *   - Push price updates to linked Platform Products in "sync" pricingMode
 *   - Record lastSyncedAt on every touched document
 *
 * This service does NOT expose products to users — it only populates the
 * internal ProviderProduct catalogue from which admins then publish.
 *
 * ─── Upgrade 1 — Controlled concurrency ──────────────────────────────────────
 *
 * Upserts now run in parallel batches of UPSERT_CONCURRENCY (default 10),
 * using Promise.allSettled so one failed product never blocks the rest.
 * The concurrency ceiling keeps MongoDB connection pressure bounded even
 * for providers with thousands of products.
 *
 * ─── Upgrade 2 — In-process sync lock ────────────────────────────────────────
 *
 * A per-provider mutex (Map<providerId, Promise>) prevents the same provider
 * from being synced concurrently — e.g. a cron tick and a manual admin trigger
 * arriving at the same millisecond.  The second caller receives a
 * BusinessRuleError with code 'SYNC_ALREADY_RUNNING' immediately, rather than
 * both running in parallel and racing on upserts.
 *
 * NOTE: The lock is in-process only.  If you run multiple Node.js replicas
 * behind a load balancer you will need a distributed lock (e.g. a short-TTL
 * MongoDB document or Redis SETNX).  For a single-process deployment — the
 * typical setup for this platform — the in-process map is sufficient and
 * has zero external dependencies.
 *
 * ─── Design invariants (unchanged) ───────────────────────────────────────────
 *   - Upserts are idempotent (unique compound index on provider+externalProductId)
 *   - translatedName is NEVER overwritten by sync
 *   - Products absent from the API response are soft-deleted (isActive=false)
 *   - Price propagation to Platform Products runs after all upserts complete
 *   - Individual product errors are collected; a bad product never aborts the run
 */

const { Provider } = require('./provider.model');
const { ProviderProduct } = require('./providerProduct.model');
const { Product, PRICING_MODES, computeFinalPrice } = require('../products/product.model');
const { getAdapter } = require('./adapters/adapter.factory');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Maximum number of ProviderProduct upserts to run in parallel per batch.
 * Tune via SYNC_UPSERT_CONCURRENCY env var.  10 is a safe default that
 * keeps MongoDB connection pressure low while still being 10× faster than
 * sequential writes for large catalogs.
 */
const UPSERT_CONCURRENCY = parseInt(process.env.SYNC_UPSERT_CONCURRENCY ?? '10', 10);

// =============================================================================
// IN-PROCESS SYNC LOCK
// =============================================================================

/**
 * Set<string>
 *
 * Contains the provider _id strings of all currently-running syncs.
 * A Set entry is ALWAYS removed in the finally block, so the lock
 * cannot leak even if the sync throws.
 *
 * This is an in-process lock: one Node.js process, one event loop.
 * For multi-process deployments, replace with a distributed lock
 * (e.g. MongoDB findOneAndUpdate with a TTL field, or Redis SETNX).
 *
 * @private
 */
const _syncLocks = new Set();

/**
 * Returns true if a sync is currently running for the given providerId.
 *
 * @param {string} providerId
 * @returns {boolean}
 */
const isSyncRunning = (providerId) => _syncLocks.has(String(providerId));

// =============================================================================
// CONCURRENCY HELPER
// =============================================================================

/**
 * Run an array of async task factories (thunks) in parallel with a ceiling
 * of `limit` concurrent promises.  Results are returned in the same order as
 * `tasks`, each wrapped as a Promise.allSettled-style settlement object.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks   - zero-argument async functions
 * @param {number}                  limit   - max concurrent promises
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

    // Launch `limit` workers; each drains the shared index counter
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);

    return results;
};

// =============================================================================
// UPSERT HELPER
// =============================================================================

/**
 * Upsert a single ProviderProduct DTO into the database.
 * translatedName is explicitly excluded from the $set so it is never overwritten.
 *
 * @param {ObjectId} providerId
 * @param {Object}   dto
 * @param {Date}     now
 * @returns {Promise<{ doc: Document, isNew: boolean }>}
 */
const _upsertOne = async (providerId, dto, now) => {
    const doc = await ProviderProduct.findOneAndUpdate(
        {
            provider: providerId,
            externalProductId: dto.externalProductId,
        },
        {
            $set: {
                rawName: dto.rawName,
                rawPrice: dto.rawPrice,
                minQty: dto.minQty ?? 1,
                maxQty: dto.maxQty ?? 9999,
                isActive: dto.isActive ?? true,
                rawPayload: dto.rawPayload ?? null,
                lastSyncedAt: now,
                // translatedName intentionally absent — admin-owned field
            },
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }
    );

    // Discriminate new vs updated: createdAt ≈ updatedAt within 100ms on the
    // same write means this was an insert, not an update.
    const createdMs = doc.createdAt?.getTime() ?? 0;
    const updatedMs = doc.updatedAt?.getTime() ?? 0;
    const isNew = Math.abs(createdMs - updatedMs) < 100;

    return { doc, isNew };
};

// =============================================================================
// MAIN SYNC FUNCTION — INTERNAL (no lock)
// =============================================================================

/**
 * _performSync(provider, adapterOptions?)
 *
 * Executes the full sync cycle for one provider.
 * Does NOT acquire the lock — callers are responsible for that.
 *
 * @param   {Document} provider
 * @param   {Object}   adapterOptions
 * @returns {Promise<SyncResult>}
 * @private
 */
const _performSync = async (provider, adapterOptions) => {
    const adapter = getAdapter(provider, adapterOptions);
    const now = new Date();
    const errors = [];
    let upserted = 0;
    let updated = 0;
    let deactivated = 0;
    let pricesSynced = 0;

    // ── 1. Fetch from provider API ────────────────────────────────────────────
    const dtos = await adapter.fetchProducts();
    // dtos: Array<{ externalProductId, rawName, rawPrice, minQty, maxQty, isActive, rawPayload }>

    const seenExternalIds = new Set();
    const touchedProviderProducts = [];  // { id, rawPrice } — for price propagation

    // ── 2. Concurrent upserts ─────────────────────────────────────────────────
    //
    // Build one thunk per DTO, then drain them through runWithConcurrency().
    // This is ~10× faster than sequential awaits for a provider with 100+ products.
    //
    const tasks = dtos.map((dto) => async () => {
        seenExternalIds.add(String(dto.externalProductId));
        const { doc, isNew } = await _upsertOne(provider._id, dto, now);
        return { doc, isNew, rawPrice: dto.rawPrice };
    });

    const settlements = await runWithConcurrency(tasks, UPSERT_CONCURRENCY);

    // Collect results; fulfilled → update counters; rejected → push to errors
    for (let i = 0; i < settlements.length; i++) {
        const settlement = settlements[i];
        const dto = dtos[i];

        if (settlement.status === 'fulfilled') {
            const { doc, isNew, rawPrice } = settlement.value;
            touchedProviderProducts.push({ id: doc._id, rawPrice });
            if (isNew) upserted++;
            else updated++;
        } else {
            errors.push(`[upsert:${dto.externalProductId}] ${settlement.reason?.message ?? 'Unknown error'}`);
        }
    }

    // Rebuild seenExternalIds from only the successfully processed DTOs
    // (failed upserts should not contribute to the "seen" set, which could
    // incorrectly deactivate products that simply had a transient error).
    //
    // Re-populate from settlements so we only mark as "seen" what we actually wrote.
    // (seenExternalIds was already populated in the task closures above, but those
    // ran eagerly regardless of success — reset and rebuild from fulfilled only)
    seenExternalIds.clear();
    for (let i = 0; i < settlements.length; i++) {
        if (settlements[i].status === 'fulfilled') {
            seenExternalIds.add(String(dtos[i].externalProductId));
        }
    }

    // ── 3. Deactivate missing products ────────────────────────────────────────
    //
    // Products previously in DB but NOT returned by the provider are considered
    // unavailable → soft-delete (isActive = false).
    // Only run when the response is non-empty; an empty response might indicate
    // a transient provider outage, not a genuine "no products" state.
    //
    if (dtos.length > 0) {
        try {
            const deactivateResult = await ProviderProduct.updateMany(
                {
                    provider: provider._id,
                    externalProductId: { $nin: Array.from(seenExternalIds) },
                    isActive: true,
                },
                {
                    $set: { isActive: false, lastSyncedAt: now },
                }
            );
            deactivated = deactivateResult.modifiedCount;
        } catch (err) {
            errors.push(`[deactivate] ${err.message}`);
        }
    }

    // ── 4. Push price updates to Platform Products (sync mode) ────────────────
    for (const { id: providerProductId, rawPrice } of touchedProviderProducts) {
        try {
            const products = await Product.find({
                providerProduct: providerProductId,
                pricingMode: PRICING_MODES.SYNC,
            }).select('markupType markupValue');

            for (const product of products) {
                const newFinalPrice = computeFinalPrice(rawPrice, product.markupType, product.markupValue);
                const newBasePrice = newFinalPrice ?? String(rawPrice);

                await Product.findByIdAndUpdate(product._id, {
                    $set: {
                        providerPrice: String(rawPrice),
                        finalPrice: newFinalPrice,
                        basePrice: newBasePrice,
                    },
                });
                pricesSynced++;
            }
        } catch (err) {
            errors.push(`[price-sync:${providerProductId}] ${err.message}`);
        }
    }

    return {
        providerId: provider._id.toString(),
        totalFetched: dtos.length,
        upserted,
        updated,
        deactivated,
        pricesSynced,
        errors,
        syncedAt: now,
    };
};

// =============================================================================
// PUBLIC: syncProviderProducts  (acquires lock)
// =============================================================================

/**
 * syncProviderProducts(providerId, adapterOptions?)
 *
 * Full sync cycle for one provider, guarded by an in-process lock.
 *
 * If the same provider is already being synced (e.g. cron + manual trigger
 * overlapping), the second caller receives a BusinessRuleError immediately
 * with code 'SYNC_ALREADY_RUNNING' so it can return a 409 without waiting.
 *
 * @param {string|ObjectId} providerId
 * @param {Object}          [adapterOptions]  - forwarded to adapter factory
 *
 * @returns {Promise<SyncResult>}
 *   SyncResult = {
 *     providerId:    string,
 *     totalFetched:  number,
 *     upserted:      number,
 *     updated:       number,
 *     deactivated:   number,
 *     pricesSynced:  number,
 *     errors:        string[],
 *     syncedAt:      Date,
 *   }
 *
 * @throws {NotFoundError}    When providerId does not exist
 * @throws {BusinessRuleError} When provider is inactive (PROVIDER_INACTIVE)
 *                              or a sync is already in progress (SYNC_ALREADY_RUNNING)
 */
const syncProviderProducts = async (providerId, adapterOptions = {}) => {
    const lockKey = String(providerId);

    // ── Lock check — must happen BEFORE the first await ───────────────────────
    //
    // Everything before the first `await` in an async function runs
    // synchronously (single-threaded JS).  Checking + adding the key here
    // is therefore atomic — no race condition is possible within one process.
    //
    if (_syncLocks.has(lockKey)) {
        throw new BusinessRuleError(
            `A sync for provider "${lockKey}" is already in progress.`,
            'SYNC_ALREADY_RUNNING'
        );
    }

    // ── Acquire lock ───────────────────────────────────────────────────
    _syncLocks.add(lockKey);      // synchronous — no await between check and add

    try {
        // ── Validate provider (now safe to await — lock is already held) ──────
        const provider = await Provider.findById(providerId);
        if (!provider) {
            throw new NotFoundError('Provider');
        }
        if (!provider.isActive) {
            throw new BusinessRuleError('Cannot sync an inactive provider.', 'PROVIDER_INACTIVE');
        }

        return await _performSync(provider, adapterOptions);

    } finally {
        // ── Release lock unconditionally (success OR any error) ──────────────
        _syncLocks.delete(lockKey);
    }
};

// =============================================================================
// PUBLIC: syncAllProviders
// =============================================================================

/**
 * syncAllProviders(adapterOptions?)
 *
 * Iterates all active providers, calls syncProviderProducts() for each.
 * Individual failures (including SYNC_ALREADY_RUNNING) are collected and do
 * NOT abort the loop.
 *
 * @returns {Promise<Array<{ providerId, result?, error? }>>}
 */
const syncAllProviders = async (adapterOptions = {}) => {
    const providers = await Provider.find({ isActive: true }).select('_id');
    const results = [];

    for (const p of providers) {
        try {
            const result = await syncProviderProducts(p._id, adapterOptions);
            results.push({ providerId: p._id, result });
        } catch (err) {
            results.push({ providerId: p._id, error: err.message });
        }
    }

    return results;
};

// =============================================================================
// PUBLIC: recalcProductPrices (admin utility)
// =============================================================================

/**
 * recalcProductPrices(providerProductId)
 *
 * Re-applies the current rawPrice of a ProviderProduct to all linked Platform
 * Products in 'sync' mode, respecting their markupType/markupValue.
 * Useful when pricingMode is toggled from 'manual' → 'sync' or when a
 * markup value changes.
 *
 * @param {string|ObjectId} providerProductId
 * @returns {Promise<{ modifiedCount: number }>}
 */
const recalcProductPrices = async (providerProductId) => {
    const pp = await ProviderProduct.findById(providerProductId);
    if (!pp) throw new NotFoundError('ProviderProduct');

    const products = await Product.find({
        providerProduct: providerProductId,
        pricingMode: PRICING_MODES.SYNC,
    }).select('markupType markupValue');

    let modifiedCount = 0;

    for (const product of products) {
        const newFinalPrice = computeFinalPrice(pp.rawPrice, product.markupType, product.markupValue);
        const newBasePrice = newFinalPrice ?? String(pp.rawPrice);

        await Product.findByIdAndUpdate(product._id, {
            $set: {
                providerPrice: String(pp.rawPrice),
                finalPrice: newFinalPrice,
                basePrice: newBasePrice,
            },
        });
        modifiedCount++;
    }

    return { modifiedCount };
};

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    syncProviderProducts,
    syncAllProviders,
    recalcProductPrices,
    // ── Exported for tests ────────────────────────────────────────────────────
    isSyncRunning,
    runWithConcurrency,   // pure utility — testable in isolation
    UPSERT_CONCURRENCY,
};
