'use strict';

/**
 * sync.service.js — backward-compatibility shim
 *
 * All sync logic has been moved to providerProductSync.service.js which
 * implements the full 3-layer architecture (markup-aware price sync,
 * product deactivation, translatedName preservation).
 *
 * This file re-exports everything from providerProductSync.service.js
 * so that existing imports of sync.service.js continue to work.
 */

const {
    syncProviderProducts,
    syncAllProviders,
    recalcProductPrices,
} = require('./providerProductSync.service');

// Re-export under both old and new names
const syncProvider = syncProviderProducts;   // old name (used by provider.controller)
const recalcSyncPrices = recalcProductPrices;   // old name

module.exports = {
    // New canonical names
    syncProviderProducts,
    syncAllProviders,
    recalcProductPrices,

    // Legacy aliases — keep working for backward compat
    syncProvider,
    recalcSyncPrices,
};
