'use strict';

/**
 * adapter.factory.js
 *
 * Resolves the correct provider adapter for a given Provider document.
 *
 * ─── Lookup priority ──────────────────────────────────────────────────────────
 * 1. provider.slug   (preferred — URL-safe, e.g. "royal-crown")
 * 2. provider.name   (lowercased, trimmed  — e.g. "royal crown" → found via "royal crown")
 *
 * Falls back to MockProviderAdapter if no match is found, which is
 * appropriate for development and test environments.
 *
 * ─── Adding a new provider ───────────────────────────────────────────────────
 * 1. Create  src/modules/providers/adapters/<name>.adapter.js
 *            extending BaseProviderAdapter
 * 2. Import it here and add to the registry map below.
 *
 * ─── Registered providers ────────────────────────────────────────────────────
 *   royal-crown  → RoyalCrownAdapter
 *   toros        → TorosfonAdapter
 *   alkasr       → AlkasrVipAdapter
 *   mock         → MockProviderAdapter  (dev / test fallback)
 *
 * ─── Export ───────────────────────────────────────────────────────────────────
 *   getAdapter(provider, adapterOptions?)     — main factory function
 *   getProviderAdapter(provider)              — alias (new canonical name)
 *   registerAdapter(providerName, Class)      — register at runtime (tests)
 */

const { MockProviderAdapter } = require('./mock.adapter');
const { RoyalCrownAdapter } = require('./royalCrown.adapter');
const { TorosfonAdapter } = require('./toros.adapter');
const { AlkasrVipAdapter } = require('./alkasr.adapter');
const { IbraAdapter } = require('./ibra.adapter');

// ─── Registry ────────────────────────────────────────────────────────────────
//
// Keys must be lowercase.  Both slug and display-name variants are registered
// so the lookup works regardless of whether provider.slug is set.
//
const registry = new Map([
    // ── Royal Crown ──────────────────────────────────────────────────────────
    ['royal-crown', RoyalCrownAdapter],   // slug
    ['royal crown', RoyalCrownAdapter],   // name (lowercase)
    ['royalcrown', RoyalCrownAdapter],   // compact variant

    // ── Torosfon Store ────────────────────────────────────────────────────────
    ['toros', TorosfonAdapter],  // slug
    ['torosfon', TorosfonAdapter],
    ['torosfon store', TorosfonAdapter],  // full display name
    ['toros-store', TorosfonAdapter],
    ['torosfonstore', TorosfonAdapter],  // compact

    // ── Alkasr VIP ────────────────────────────────────────────────────────────
    ['alkasr', AlkasrVipAdapter],  // slug
    ['alkasr-vip', AlkasrVipAdapter],
    ['alkasr vip', AlkasrVipAdapter],  // display name
    ['alkasrvip', AlkasrVipAdapter],  // compact

    // ── brand1-card (Uses Alkasr Adapter) ─────────────────────────────────────
    ['brand1-card', AlkasrVipAdapter], // slug
    ['brand1 card', AlkasrVipAdapter], // name
    ['brand1card', AlkasrVipAdapter],  // compact

    // ── Miral Store (Uses Alkasr Adapter) ─────────────────────────────────────
    ['miral-store', AlkasrVipAdapter], // slug
    ['miral store', AlkasrVipAdapter], // name
    ['miralstore', AlkasrVipAdapter],  // compact

    // -- Ibra Store ------------------------------------------------------------
    ['ibra-store', IbraAdapter],
    ['ibrastore', IbraAdapter],
    ['ibra', IbraAdapter],


    // ── Default test / dev adapter ────────────────────────────────────────────
    ['mock', MockProviderAdapter],
]);

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Get an adapter instance for the given provider document.
 *
 * Lookup order:
 *   1. provider.slug  (exact match, lowercase)
 *   2. provider.name  (lowercase, trimmed)
 *   3. Fallback → MockProviderAdapter
 *
 * @param {Object} provider          - Provider Mongoose document
 * @param {Object} [adapterOptions]  - extra options forwarded to adapter constructor
 *                                     (used in tests to inject mock data / behavior)
 * @returns {BaseProviderAdapter}
 */
const getAdapter = (provider, adapterOptions = {}) => {
    const bySlug = (provider.slug ?? '').toLowerCase().trim();
    const byName = (provider.name ?? '').toLowerCase().trim();

    const AdapterClass = registry.get(bySlug)
        ?? registry.get(byName)
        ?? MockProviderAdapter;

    return new AdapterClass(provider, adapterOptions);
};

/**
 * getProviderAdapter — canonical alias for getAdapter.
 * Use this in new code; getAdapter is kept for backward compat with sync.service.js.
 *
 * @throws {Error} 'UNSUPPORTED_PROVIDER' if slug/name is unknown AND strict=true
 *
 * @param {Object}  provider
 * @param {Object}  [options]
 * @param {boolean} [options.strict=false] — throw instead of falling back to mock
 * @returns {BaseProviderAdapter}
 */
const getProviderAdapter = (provider, options = {}) => {
    const bySlug = (provider.slug ?? '').toLowerCase().trim();
    const byName = (provider.name ?? '').toLowerCase().trim();

    const AdapterClass = registry.get(bySlug) ?? registry.get(byName);

    if (!AdapterClass) {
        if (options.strict) {
            throw new Error(
                `UNSUPPORTED_PROVIDER: No adapter registered for slug="${bySlug}" / name="${byName}".`
            );
        }
        return new MockProviderAdapter(provider, options);
    }

    return new AdapterClass(provider, options);
};

/**
 * Register a new adapter class at runtime.
 * Useful for plugins or test overrides.
 *
 * @param {string}   providerKey   - slug or lowercase name
 * @param {Function} AdapterClass  - must extend BaseProviderAdapter
 */
const registerAdapter = (providerKey, AdapterClass) => {
    registry.set(providerKey.toLowerCase().trim(), AdapterClass);
};

module.exports = { getAdapter, getProviderAdapter, registerAdapter };
