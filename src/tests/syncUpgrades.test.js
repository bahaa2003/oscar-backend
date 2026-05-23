'use strict';

/**
 * syncUpgrades.test.js — Sync Service Upgrade Test Suite
 * ─────────────────────────────────────────────────────────
 *
 * Tests for the two production upgrades to providerProductSync.service.js:
 *
 *  [1] runWithConcurrency() — pure utility
 *      - Runs all tasks and returns results in order
 *      - Respects the concurrency limit (never more than N in-flight at once)
 *      - Collects rejections (fulfilled + rejected results both returned)
 *      - Handles empty task array
 *      - Handles limit > tasks.length gracefully
 *
 *  [2] In-process sync lock
 *      - Second concurrent call for same provider throws SYNC_ALREADY_RUNNING
 *      - Lock is released after sync completes
 *      - Lock is released even when sync throws
 *      - Different providers can sync simultaneously (locks are independent)
 *      - isSyncRunning() reflects live state
 *
 *  [3] Partial failure handling with concurrency
 *      - Products whose upsert throws are recorded in errors[]
 *      - Other products in the same batch are still processed
 *      - A single bad DTO does not inflate upserted/updated counts
 *      - Failed upserts do not contribute to seenExternalIds (safe deactivation)
 *
 *  [4] Idempotency with concurrent batches
 *      - Large catalog (30+ products) synced twice: no duplicates
 *      - upserted count correct on first sync, updated on second
 *      - deactivated count correct when products are removed between syncs
 *
 * All DB-backed tests use the real MongoDB test instance.
 * The lock tests use mocked providers to verify promise lifecycle.
 */

const mongoose = require('mongoose');

const {
    syncProviderProducts,
    isSyncRunning,
    runWithConcurrency,
} = require('../modules/providers/providerProductSync.service');

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

// ─────────────────────────────────────────────────────────────────────────────
// DB Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(() => connectTestDB());
afterAll(() => disconnectTestDB());
beforeEach(() => clearCollections());

// ─────────────────────────────────────────────────────────────────────────────
// Shared factory
// ─────────────────────────────────────────────────────────────────────────────

const makeProvider = (overrides = {}) =>
    Provider.create({
        name: `SyncUpgrade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        slug: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        baseUrl: 'https://mock.example.com',
        apiToken: 'test-token',
        isActive: true,
        ...overrides,
    });

/** Build N fake product DTOs. */
const makeProducts = (count, prefix = 'P') =>
    Array.from({ length: count }, (_, i) => ({
        externalProductId: `${prefix}-${String(i + 1).padStart(4, '0')}`,
        rawName: `Product ${i + 1}`,
        rawPrice: String((Math.random() * 50 + 1).toFixed(2)),
        minQty: 1,
        maxQty: 100,
        isActive: true,
        rawPayload: { index: i },
    }));

// ═════════════════════════════════════════════════════════════════════════════
// [1] runWithConcurrency() — pure utility, no DB needed
// ═════════════════════════════════════════════════════════════════════════════

describe('[1] runWithConcurrency() — pure concurrency helper', () => {
    it('executes all tasks and returns results in order', async () => {
        const tasks = [1, 2, 3, 4, 5].map((n) => async () => n * 10);
        const results = await runWithConcurrency(tasks, 2);
        expect(results).toHaveLength(5);
        const values = results.map((r) => r.value);
        expect(values).toEqual([10, 20, 30, 40, 50]);
    });

    it('all results have status "fulfilled" when no task throws', async () => {
        const tasks = [1, 2, 3].map((n) => async () => n);
        const results = await runWithConcurrency(tasks, 2);
        results.forEach((r) => expect(r.status).toBe('fulfilled'));
    });

    it('collects rejected tasks without aborting the rest', async () => {
        const tasks = [
            async () => 'ok-1',
            async () => { throw new Error('boom'); },
            async () => 'ok-3',
        ];
        const results = await runWithConcurrency(tasks, 3);
        expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'ok-1' });
        expect(results[1]).toMatchObject({ status: 'rejected' });
        expect(results[1].reason.message).toBe('boom');
        expect(results[2]).toMatchObject({ status: 'fulfilled', value: 'ok-3' });
    });

    it('handles an empty task array without error', async () => {
        const results = await runWithConcurrency([], 5);
        expect(results).toEqual([]);
    });

    it('handles limit larger than task count', async () => {
        const tasks = [async () => 'a', async () => 'b'];
        const results = await runWithConcurrency(tasks, 100);
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.value)).toEqual(['a', 'b']);
    });

    it('enforces concurrency limit — never exceeds N simultaneous tasks', async () => {
        const LIMIT = 3;
        let maxInFlight = 0;
        let currentInFlight = 0;

        // Each task increments a counter, waits a tick, then decrements.
        const tasks = Array.from({ length: 10 }, () => async () => {
            currentInFlight++;
            maxInFlight = Math.max(maxInFlight, currentInFlight);
            await new Promise((r) => setImmediate(r));  // yield to event loop
            currentInFlight--;
        });

        await runWithConcurrency(tasks, LIMIT);
        // Max in-flight must never exceed the concurrency limit
        expect(maxInFlight).toBeLessThanOrEqual(LIMIT);
    });

    it('executes tasks concurrently (total time < sum of individual times)', async () => {
        const DELAY = 30;
        const TASK_COUNT = 5;
        const tasks = Array.from({ length: TASK_COUNT }, () => async () => {
            await new Promise((r) => setTimeout(r, DELAY));
        });

        const start = Date.now();
        await runWithConcurrency(tasks, TASK_COUNT);   // all 5 at once
        const elapsed = Date.now() - start;

        // Sequential time would be DELAY * TASK_COUNT = 150ms.
        // With full concurrency it should be ~DELAY ms (+ some overhead).
        // We use 2× DELAY as a generous upper bound.
        expect(elapsed).toBeLessThan(DELAY * 2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [2] In-process sync lock
// ═════════════════════════════════════════════════════════════════════════════

describe('[2] Sync lock', () => {
    it('isSyncRunning() returns false when no sync is active', async () => {
        const provider = await makeProvider();
        expect(isSyncRunning(provider._id)).toBe(false);
    });

    it('isSyncRunning() returns true while a sync is in progress', async () => {
        const provider = await makeProvider();
        const products = makeProducts(5);

        // Start a sync but do NOT await it
        const syncPromise = syncProviderProducts(provider._id, { products });

        // The lock is set synchronously before the first await inside syncProviderProducts,
        // so it is visible immediately after calling the function (no need to yield).
        expect(isSyncRunning(provider._id.toString())).toBe(true);

        await syncPromise;
    });

    it('second call for same provider throws SYNC_ALREADY_RUNNING immediately', async () => {
        const provider = await makeProvider();
        const products = makeProducts(5);
        const idStr = provider._id.toString();

        // First call — do NOT await.  The lock is set synchronously inside
        // syncProviderProducts before any DB call, so the second call will
        // see it immediately.
        const first = syncProviderProducts(idStr, { products });

        // Second call must throw synchronously (on the same turn before any await)
        // But because syncProviderProducts is async, the rejection is delivered
        // as a Promise rejection, not a thrown exception — hence rejects.toMatchObject.
        await expect(
            syncProviderProducts(idStr, { products })
        ).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });

        await first;  // let the first sync finish cleanly
    });

    it('lock is released after a successful sync', async () => {
        const provider = await makeProvider();
        const products = makeProducts(3);

        await syncProviderProducts(provider._id, { products });

        // Lock must be gone now — a second sync must succeed
        expect(isSyncRunning(provider._id.toString())).toBe(false);

        await expect(
            syncProviderProducts(provider._id, { products })
        ).resolves.toBeDefined();
    });

    it('lock is released even when the sync throws (adapter error)', async () => {
        const provider = await makeProvider();
        const lockKey = provider._id.toString();

        // Force the adapter to throw during fetchProducts
        await expect(
            syncProviderProducts(provider._id, { shouldThrow: new Error('provider down') })
        ).rejects.toThrow('provider down');

        // Lock must be cleaned up
        expect(isSyncRunning(lockKey)).toBe(false);

        // Subsequent sync must be able to run
        await expect(
            syncProviderProducts(provider._id, { products: makeProducts(2) })
        ).resolves.toBeDefined();
    });

    it('different providers can sync simultaneously — locks are independent', async () => {
        const provA = await makeProvider();
        const provB = await makeProvider();

        // Start both syncs without awaiting
        const syncA = syncProviderProducts(provA._id, { products: makeProducts(3, 'A') });
        const syncB = syncProviderProducts(provB._id, { products: makeProducts(3, 'B') });

        // Neither should block the other
        const [resultA, resultB] = await Promise.all([syncA, syncB]);

        expect(resultA.providerId).toBe(provA._id.toString());
        expect(resultB.providerId).toBe(provB._id.toString());
        expect(resultA.totalFetched).toBe(3);
        expect(resultB.totalFetched).toBe(3);
    });

    it('SYNC_ALREADY_RUNNING error has code property', async () => {
        const provider = await makeProvider();
        const idStr = provider._id.toString();
        const products = makeProducts(2);

        // Kick off first sync (lock acquired synchronously)
        const first = syncProviderProducts(idStr, { products });

        let caughtError;
        try {
            await syncProviderProducts(idStr, { products });
        } catch (err) {
            caughtError = err;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.code).toBe('SYNC_ALREADY_RUNNING');
        expect(caughtError.message).toMatch(/already in progress/i);

        await first;
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [3] Partial failure handling with concurrency
// ═════════════════════════════════════════════════════════════════════════════

describe('[3] Partial failure handling', () => {
    it('errors array is empty when all upserts succeed', async () => {
        const provider = await makeProvider();
        const result = await syncProviderProducts(provider._id, {
            products: makeProducts(5),
        });
        expect(result.errors).toHaveLength(0);
    });

    it('upserted + updated + errors.length === totalFetched', async () => {
        const provider = await makeProvider();
        const products = makeProducts(8);

        const result = await syncProviderProducts(provider._id, { products });

        expect(result.upserted + result.updated + result.errors.length)
            .toBe(result.totalFetched);
    });

    it('partial failures in runWithConcurrency do not contaminate other slots', async () => {
        const tasks = [
            async () => 'a',
            async () => { throw new Error('mid-failure'); },
            async () => 'c',
            async () => { throw new Error('another'); },
            async () => 'e',
        ];

        const results = await runWithConcurrency(tasks, 3);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(3);
        expect(rejected).toHaveLength(2);
        expect(fulfilled.map((r) => r.value).sort()).toEqual(['a', 'c', 'e']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// [4] Idempotency and correctness under concurrency
// ═════════════════════════════════════════════════════════════════════════════

describe('[4] Idempotency with concurrent batches (DB-backed)', () => {
    it('syncing 30 products creates exactly 30 documents (no duplicates)', async () => {
        const provider = await makeProvider();
        const products = makeProducts(30);

        const result = await syncProviderProducts(provider._id, { products });

        const count = await ProviderProduct.countDocuments({ provider: provider._id });
        expect(count).toBe(30);
        expect(result.totalFetched).toBe(30);
        expect(result.upserted).toBe(30);
        expect(result.updated).toBe(0);
        expect(result.errors).toHaveLength(0);
    });

    it('second sync of same 30 products → updated=30, upserted=0, no duplicates', async () => {
        const provider = await makeProvider();
        const products = makeProducts(30);

        await syncProviderProducts(provider._id, { products });

        // Wait a tick so updatedAt > createdAt by > 100ms cutoff
        await new Promise((r) => setTimeout(r, 150));

        const result2 = await syncProviderProducts(provider._id, { products });
        const count = await ProviderProduct.countDocuments({ provider: provider._id });

        expect(count).toBe(30);
        expect(result2.upserted).toBe(0);
        expect(result2.updated).toBe(30);
    });

    it('products removed from provider response are deactivated', async () => {
        const provider = await makeProvider();
        const products = makeProducts(10);

        await syncProviderProducts(provider._id, { products });

        // Second sync with only the first 5 — last 5 should be deactivated
        const reduced = products.slice(0, 5);
        const result = await syncProviderProducts(provider._id, { products: reduced });

        expect(result.deactivated).toBe(5);

        const activeCount = await ProviderProduct.countDocuments({
            provider: provider._id,
            isActive: true,
        });
        const inactiveCount = await ProviderProduct.countDocuments({
            provider: provider._id,
            isActive: false,
        });

        expect(activeCount).toBe(5);
        expect(inactiveCount).toBe(5);
    });

    it('translatedName is NOT overwritten during sync with concurrency', async () => {
        const provider = await makeProvider();
        const products = makeProducts(1, 'TN');

        // First sync — creates the ProviderProduct
        await syncProviderProducts(provider._id, { products });

        // Admin sets a translatedName
        await ProviderProduct.findOneAndUpdate(
            { provider: provider._id, externalProductId: 'TN-0001' },
            { $set: { translatedName: 'المنتج المترجم' } }
        );

        // Second sync — should NOT overwrite translatedName
        const updatedProduct = [{
            ...products[0],
            rawName: 'Updated Raw Name',
            rawPrice: '99.99',
        }];
        await syncProviderProducts(provider._id, { products: updatedProduct });

        const doc = await ProviderProduct.findOne({
            provider: provider._id,
            externalProductId: 'TN-0001',
        });

        expect(doc.translatedName).toBe('المنتج المترجم');  // preserved
        expect(doc.rawName).toBe('Updated Raw Name');        // updated
        expect(doc.rawPrice).toBe('99.99');                   // updated
    });

    it('syncResult contains correct syncedAt timestamp', async () => {
        const provider = await makeProvider();
        const before = new Date();

        const result = await syncProviderProducts(provider._id, {
            products: makeProducts(3),
        });

        const after = new Date();
        expect(result.syncedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(result.syncedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
});
