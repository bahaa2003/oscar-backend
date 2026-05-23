'use strict';

/**
 * syncProvidersJob.js
 *
 * Background cron job that auto-syncs the provider product catalogue
 * every 6 hours (configurable).
 *
 * This is SEPARATE from fulfillmentJob.js (which polls order statuses).
 *
 * Lifecycle:
 *   start()   — schedule the job (called once from server.js after DB connects)
 *   stop()    — graceful shutdown (SIGTERM / SIGINT)
 *   runOnce() — execute one full sync cycle (also callable from admin routes)
 *
 * Design:
 *   - node-cron for scheduling (no extra infrastructure required)
 *   - Serialised runs: _running flag prevents overlapping cycles
 *   - No job in test environment (NODE_ENV === 'test')
 *   - Individual provider failures are captured — never crash the whole cycle
 *   - Logs PROVIDER_SYNC_FAILED per provider on error
 */

const cron = require('node-cron');
const { syncAllProviders } = require('./providerCatalog.service');

// ── State ─────────────────────────────────────────────────────────────────────

let _task = null;
let _running = false;

// ── Sync cycle ────────────────────────────────────────────────────────────────

/**
 * runOnce(adapterOptions?)
 *
 * Execute one complete sync cycle across all active providers.
 * Safe to call manually (admin trigger, testing).
 *
 * @param {Object} [adapterOptions] - forwarded to adapter factory (inject mocks in tests)
 * @returns {Promise<Array|null>}   - array of per-provider results, or null if locked/skipped
 */
const runOnce = async (adapterOptions = {}) => {
    if (_running) {
        console.log('[SyncJob] Skipping tick — previous sync still in progress.');
        return null;
    }

    _running = true;
    const startedAt = Date.now();

    try {
        console.log('[SyncJob] Starting provider product sync…');

        const results = await syncAllProviders(adapterOptions);

        const elapsed = Date.now() - startedAt;
        let successful = 0;
        let failed = 0;

        for (const r of results) {
            if (r.error) {
                failed++;
                // Log per-provider failures — never crash the cycle
                console.error(
                    `[SyncJob] PROVIDER_SYNC_FAILED provider=${r.providerId}: ${r.error}`
                );
            } else {
                successful++;
                console.log(
                    `[SyncJob] provider=${r.providerId} ` +
                    `fetched=${r.result.totalFetched} ` +
                    `upserted=${r.result.upserted} ` +
                    `updated=${r.result.updated} ` +
                    `pricesSynced=${r.result.pricesSynced} ` +
                    `errors=${r.result.errors.length}`
                );
            }
        }

        console.log(
            `[SyncJob] Sync complete in ${elapsed}ms — ` +
            `${successful} succeeded, ${failed} failed.`
        );

        return results;

    } catch (err) {
        const elapsed = Date.now() - startedAt;
        console.error(`[SyncJob] Unhandled error after ${elapsed}ms:`, err.message);
        return null;
    } finally {
        _running = false;
    }
};

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * start(schedule?, adapterOptions?)
 *
 * Schedule the sync job.
 * Default: every 6 hours, aligned to midnight UTC ("0 0,6,12,18 * * *").
 *
 * @param {string} [schedule='0 0,6,12,18 * * *'] - cron expression
 * @param {Object} [adapterOptions]                - adapter override (tests only)
 */
const start = (schedule = '0 0,6,12,18 * * *', adapterOptions = {}) => {
    if (process.env.NODE_ENV === 'test') {
        console.log('[SyncJob] Skipped in test environment.');
        return;
    }

    if (_task) {
        console.warn('[SyncJob] Already started — ignoring duplicate start().');
        return;
    }

    console.log(`[SyncJob] Scheduling provider sync: '${schedule}'`);

    _task = cron.schedule(schedule, async () => {
        await runOnce(adapterOptions);
    });

    console.log('[SyncJob] Provider sync job started.');
};

/**
 * stop()
 * Stop the scheduler. Called on graceful shutdown.
 */
const stop = () => {
    if (_task) {
        _task.stop();
        _task = null;
        console.log('[SyncJob] Provider sync job stopped.');
    }
};

module.exports = { start, stop, runOnce };
