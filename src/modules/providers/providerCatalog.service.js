'use strict';

/**
 * providerCatalog.service.js
 *
 * Dedicated catalog service for syncing raw provider products (Layer 2).
 *
 * This service is the single entry-point for the sync engine, callable by:
 *   - Admin HTTP endpoints (manual trigger)
 *   - syncProvidersJob (background cron)
 *   - Tests
 *
 * All heavy lifting delegates to providerProductSync.service.js which
 * holds the full upsert + deactivation + price-cascade logic.
 *
 * Functions:
 *   syncProviderProducts(providerId, adapterOptions?)
 *   syncAllProviders(adapterOptions?)
 */

const {
    syncProviderProducts: _syncProviderProducts,
    syncAllProviders: _syncAllProviders,
    recalcProductPrices,
} = require('./providerProductSync.service');

// ── Re-export with canonical names expected by the catalog API ─────────────────

/**
 * syncProviderProducts(providerId, adapterOptions?)
 *
 * Sync raw product catalogue for a single provider.
 *
 * Flow:
 *   1. Load Provider document
 *   2. Resolve adapter via factory (getProviderAdapter)
 *   3. adapter.getProducts() → ProviderProductDTOs
 *   4. Upsert into provider_products (idempotent)
 *   5. Update lastSyncedAt on every touched document
 *   6. Push price updates to linked Platform Products in "sync" pricingMode
 *
 * @param {string|ObjectId} providerId
 * @param {Object}          [adapterOptions] - forwarded to adapter factory (useful in tests)
 * @returns {Promise<SyncResult>}
 *   {
 *     providerId,
 *     totalFetched,
 *     upserted,
 *     updated,
 *     deactivated,
 *     pricesSynced,
 *     errors,
 *     syncedAt
 *   }
 */
const syncProviderProducts = _syncProviderProducts;

/**
 * syncAllProviders(adapterOptions?)
 *
 * Iterates all active providers and syncs each one.
 * Individual provider failures are collected — one error never aborts others.
 *
 * Used by syncProvidersJob (cron) and the bulk-sync admin endpoint.
 *
 * @param {Object} [adapterOptions]
 * @returns {Promise<Array<{ providerId, result?, error? }>>}
 */
const syncAllProviders = _syncAllProviders;

module.exports = {
    syncProviderProducts,
    syncAllProviders,
    recalcProductPrices,
};
