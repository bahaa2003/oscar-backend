'use strict';

/**
 * orderPolling.job.js
 *
 * Cron-compatible job wrapper for the Order Status Poller.
 *
 * Exports:
 *   runOrderPolling(options?) — execute one polling cycle and log summary
 *   start(schedule?)         — schedule recurring polling with node-cron
 *   stop()                   — graceful shutdown
 *
 * Design:
 *   - Uses an execution lock (_running) so cron ticks are skipped when the
 *     previous cycle is still in progress.
 *   - Provides rich structured logging for observability.
 *   - Never throws — all errors are caught and logged.
 *   - In test environments (NODE_ENV === 'test') the cron scheduler is NOT
 *     started, but runOrderPolling() can be called directly in tests.
 *
 * Relationship to fulfillmentJob.js:
 *   fulfillmentJob.js    — handles placeOrder flow (single-provider, legacy API)
 *   orderPolling.job.js  — handles status-check polling (multi-provider, new)
 *   Both can coexist; the cron schedules are independent.
 */

const cron = require('node-cron');
const { pollPendingOrders } = require('./orderPolling.service');

// ── State ─────────────────────────────────────────────────────────────────────

let _task = null;   // node-cron ScheduledTask
let _running = false;  // execution lock

// =============================================================================
// MAIN: runOrderPolling
// =============================================================================

/**
 * Execute one complete polling cycle.
 * Safe to call manually from admin triggers, tests, or the cron handler.
 *
 * @param {Object} [options]
 * @param {Object} [options.adapterOverrides]
 *   Map<providerId_string, adapterInstance>
 *   Injected adapters bypass the factory — useful for integration tests.
 *
 * @returns {Promise<{
 *   checkedOrders:    number,
 *   completed:        number,
 *   failed:           number,
 *   stillProcessing:  number,
 *   skippedOrders:    number,
 *   errors:           string[],
 *   polledAt:         Date,
 *   elapsedMs:        number,
 * } | null>}  null if an overlapping run is still in progress
 */
const runOrderPolling = async (options = {}) => {
    if (_running) {
        console.log('[OrderPollingJob] Skipping tick — previous run still in progress.');
        return null;
    }

    _running = true;
    const startedAt = Date.now();

    try {
        console.log('[OrderPollingJob] Starting order status poll…');

        const stats = await pollPendingOrders(options);
        const elapsedMs = Date.now() - startedAt;

        // ── Summary log ───────────────────────────────────────────────────────
        console.log(
            '[OrderPollingJob] Poll complete.',
            JSON.stringify({
                checkedOrders: stats.checkedOrders,
                completed: stats.completed,
                failed: stats.failed,
                stillProcessing: stats.stillProcessing,
                skippedOrders: stats.skippedOrders,
                errorCount: stats.errors.length,
                elapsedMs,
            })
        );

        if (stats.errors.length > 0) {
            console.warn('[OrderPollingJob] Errors during poll:', stats.errors);
        }

        if (stats.providerResults.length > 0) {
            for (const pr of stats.providerResults) {
                console.log(
                    `[OrderPollingJob] Provider ${pr.providerId}: ` +
                    `checked=${pr.checked} completed=${pr.completed} ` +
                    `failed=${pr.failed} pending=${pr.pending} ` +
                    `errors=${pr.errors.length}`
                );
            }
        }

        return {
            checkedOrders: stats.checkedOrders,
            completed: stats.completed,
            failed: stats.failed,
            stillProcessing: stats.stillProcessing,
            skippedOrders: stats.skippedOrders,
            errors: stats.errors,
            polledAt: stats.polledAt,
            elapsedMs,
        };

    } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        console.error('[OrderPollingJob] Unhandled error in polling cycle:', err.message);
        return {
            checkedOrders: 0,
            completed: 0,
            failed: 0,
            stillProcessing: 0,
            skippedOrders: 0,
            errors: [err.message],
            polledAt: new Date(),
            elapsedMs,
        };
    } finally {
        _running = false;
    }
};

// =============================================================================
// CRON SCHEDULER
// =============================================================================

/**
 * Start the polling cron job.
 * Call once from server.js after the DB connection is established.
 *
 * Does nothing in test environments (NODE_ENV === 'test') — call
 * runOrderPolling() directly in tests instead.
 *
 * @param {string} [schedule='* * * * *']  — cron expression (default: every minute)
 * @param {Object} [options]               — forwarded to runOrderPolling()
 */
const start = (schedule = '* * * * *', options = {}) => {
    if (process.env.NODE_ENV === 'test') {
        console.log('[OrderPollingJob] Skipped in test environment.');
        return;
    }

    if (_task) {
        console.warn('[OrderPollingJob] Already started — ignoring duplicate start().');
        return;
    }

    console.log(`[OrderPollingJob] Scheduling order status poll: '${schedule}'`);

    _task = cron.schedule(schedule, async () => {
        await runOrderPolling(options);
    });

    console.log('[OrderPollingJob] Order polling cron job started.');
};

/**
 * Stop the cron scheduler (graceful shutdown).
 */
const stop = () => {
    if (_task) {
        _task.stop();
        _task = null;
        console.log('[OrderPollingJob] Order polling cron job stopped.');
    }
};

module.exports = { runOrderPolling, start, stop };
