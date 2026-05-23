'use strict';

/**
 * exchangeRateSync.job.js
 *
 * Cron job that syncs market exchange rates every 6 hours.
 *
 * Lifecycle:
 *   start()     — schedule the cron (call once from server.js after DB connects)
 *   stop()      — graceful shutdown
 *   runOnce()   — execute one sync cycle (admin trigger / tests)
 *
 * Design:
 *   - Execution lock (_running) prevents overlapping runs.
 *   - No-op in test environments (NODE_ENV === 'test').
 *   - syncRates() is fault-tolerant; individual currency failures are logged
 *     but never bubble up to crash the job.
 */

const cron = require('node-cron');
const { syncRates } = require('../services/exchangeRateSync.service');

// ── State ─────────────────────────────────────────────────────────────────────

let _task = null;
let _running = false;

// =============================================================================
// runOnce
// =============================================================================

/**
 * Execute one exchange rate sync cycle.
 * Safe to call from admin trigger, test, or cron handler.
 *
 * @param {Object} [options]  - forwarded to syncRates() (e.g. ratesOverride for tests)
 * @returns {Promise<Object|null>}  SyncResult, or null if already running
 */
const runOnce = async (options = {}) => {
    if (_running) {
        console.log('[ExchangeRateSyncJob] Skipping tick — previous run still in progress.');
        return null;
    }

    _running = true;
    const startedAt = Date.now();

    try {
        console.log('[ExchangeRateSyncJob] Starting exchange rate sync…');
        const result = await syncRates(options);
        const elapsedMs = Date.now() - startedAt;

        console.log(
            '[ExchangeRateSyncJob] Sync complete.',
            JSON.stringify({
                synced: result.synced,
                created: result.created,
                skipped: result.skipped,
                errors: result.errors.length,
                elapsedMs,
            })
        );

        if (result.errors.length > 0) {
            console.warn('[ExchangeRateSyncJob] Sync errors:', result.errors);
        }

        return { ...result, elapsedMs };

    } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        console.error('[ExchangeRateSyncJob] Unhandled error in sync cycle:', err.message);
        return { synced: 0, created: 0, skipped: 0, errors: [err.message], elapsedMs };
    } finally {
        _running = false;
    }
};

// =============================================================================
// start / stop
// =============================================================================

/**
 * Start the cron scheduler.
 * Default: every 6 hours.
 *
 * @param {string} [schedule]   - cron expression (default: every 6 hours)
 * @param {Object} [options]    - forwarded to runOnce()
 */
const start = (schedule = '0 */6 * * *', options = {}) => {
    if (process.env.NODE_ENV === 'test') {
        console.log('[ExchangeRateSyncJob] Skipped in test environment.');
        return;
    }

    if (_task) {
        console.warn('[ExchangeRateSyncJob] Already started — ignoring duplicate start().');
        return;
    }

    console.log(`[ExchangeRateSyncJob] Scheduling exchange rate sync: '${schedule}'`);

    _task = cron.schedule(schedule, async () => {
        await runOnce(options);
    });

    console.log('[ExchangeRateSyncJob] Exchange rate sync cron job started.');
};

/**
 * Stop the cron scheduler.
 */
const stop = () => {
    if (_task) {
        _task.stop();
        _task = null;
        console.log('[ExchangeRateSyncJob] Exchange rate sync cron job stopped.');
    }
};

module.exports = { runOnce, start, stop };
