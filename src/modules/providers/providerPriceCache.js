'use strict';

/**
 * providerPriceCache.js — In-Memory Provider Price Cache
 * ──────────────────────────────────────────────────────
 * Lightweight TTL cache for provider product catalogs.
 *
 * Problem:
 *   Provider APIs only support fetching the ENTIRE catalog (no single-product
 *   lookup). Calling getProducts() on every order would cause massive latency
 *   and risk provider rate limits.
 *
 * Solution:
 *   Cache the full catalog per provider with a configurable TTL (default 5 min).
 *   JIT price checks hit the cache first; on miss, fetch once and cache for all
 *   subsequent orders within the TTL window.
 *
 * Design:
 *   - Simple Map<providerId, { prices: Map<externalProductId, rawPrice>, expiresAt }>
 *   - No external dependencies (no Redis required for single-process deployment)
 *   - Thread-safe for single-process Node.js (event loop guarantees)
 *   - Stampede protection: concurrent cache misses for the same provider share
 *     a single in-flight fetch via a pending Promise map
 *
 * @module providerPriceCache
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Cache TTL in milliseconds. Default: 5 minutes.
 * Override via PROVIDER_PRICE_CACHE_TTL_MS env var.
 */
const CACHE_TTL_MS = parseInt(process.env.PROVIDER_PRICE_CACHE_TTL_MS ?? String(5 * 60 * 1000), 10);

// ─── Internal State ───────────────────────────────────────────────────────────

/**
 * @type {Map<string, { prices: Map<string, number>, expiresAt: number }>}
 */
const _cache = new Map();

/**
 * In-flight fetch promises — prevents thundering herd when multiple orders
 * for the same provider arrive simultaneously on a cold cache.
 *
 * @type {Map<string, Promise<Map<string, number>>>}
 */
const _pending = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the live price for a single product from a provider's cached catalog.
 *
 * On cache hit:  Returns immediately (~0ms).
 * On cache miss: Fetches the full catalog via adapter.getProducts(), caches it,
 *                then returns the requested product's price.
 *
 * @param {string}              providerId          - Provider document _id
 * @param {string}              externalProductId   - The provider's product/service ID
 * @param {BaseProviderAdapter} adapter             - Resolved provider adapter instance
 * @returns {Promise<number|null>}  rawPrice, or null if product not found in catalog
 */
const getLivePrice = async (providerId, externalProductId, adapter) => {
    const key = String(providerId);
    const extId = String(externalProductId);

    // ── 1. Cache hit check ────────────────────────────────────────────────────
    const cached = _cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.prices.get(extId) ?? null;
    }

    // ── 2. Cache miss — fetch (with stampede protection) ──────────────────────
    if (!_pending.has(key)) {
        const fetchPromise = _fetchAndCache(key, adapter);
        _pending.set(key, fetchPromise);

        // Cleanup pending entry after resolution (success or failure)
        fetchPromise.finally(() => _pending.delete(key));
    }

    // Wait for the shared fetch to complete
    const prices = await _pending.get(key);
    return prices.get(extId) ?? null;
};

/**
 * Invalidate the cache for a specific provider.
 * Called after a price-increase auto-update so the next order sees fresh data.
 *
 * @param {string} providerId
 */
const invalidate = (providerId) => {
    _cache.delete(String(providerId));
};

/**
 * Clear the entire cache. Useful for tests.
 */
const clearAll = () => {
    _cache.clear();
    _pending.clear();
};

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Fetch the full product catalog from the provider, build a price lookup map,
 * and store it in the cache with TTL.
 *
 * @param {string}              key     - providerId as string
 * @param {BaseProviderAdapter} adapter
 * @returns {Promise<Map<string, number>>}
 * @private
 */
const _fetchAndCache = async (key, adapter) => {
    const dtos = await adapter.getProducts();

    /** @type {Map<string, number>} */
    const prices = new Map();
    for (const dto of dtos) {
        prices.set(String(dto.externalProductId), dto.rawPrice);
    }

    _cache.set(key, {
        prices,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return prices;
};

module.exports = {
    getLivePrice,
    invalidate,
    clearAll,
    // Exported for tests / monitoring
    CACHE_TTL_MS,
};
