'use strict';

/**
 * royalCrownProvider.js — backward-compatibility shim
 *
 * The real implementation has moved to:
 *   src/modules/providers/adapters/royalCrown.adapter.js
 *
 * This file re-exports the adapter class under the original names so that
 * any code that still imports from this file continues to work.
 *
 * You should prefer importing directly from the adapter or using the factory:
 *   const { getProviderAdapter } = require('./adapters/adapter.factory');
 *   const adapter = getProviderAdapter(providerDoc);
 */

const { RoyalCrownAdapter, ProviderAPIError } = require('./adapters/royalCrown.adapter');

/**
 * RoyalCrownProvider — alias of RoyalCrownAdapter.
 *
 * Accepts the same constructor options as the old class:
 *   new RoyalCrownProvider({ baseUrl, token, timeoutMs })
 *
 * DIFFERENCE: The new adapter constructor takes a provider document object
 * ({ baseUrl, apiToken }) rather than `{ baseUrl, token }`.
 * The shim constructor below bridges the two shapes.
 */
class RoyalCrownProvider extends RoyalCrownAdapter {
    /**
     * @param {Object} [options]
     * @param {string} [options.baseUrl]   - override provider.baseUrl
     * @param {string} [options.token]     - override provider.apiToken  (old name)
     * @param {number} [options.timeoutMs] - override default 15 s timeout
     */
    constructor(options = {}) {
        // Bridge old options shape → new provider-document shape
        const providerDoc = {
            baseUrl: options.baseUrl ?? process.env.PROVIDER_BASE_URL,
            apiToken: options.token ?? process.env.PROVIDER_API_TOKEN,
            apiKey: options.token ?? process.env.PROVIDER_API_TOKEN,
            name: 'Royal Crown',
            slug: 'royal-crown',
        };
        super(providerDoc, { timeoutMs: options.timeoutMs });

        // Surface old method aliases directly on the instance for compat
        // (base class already defines fetchProducts → getProducts,
        //  checkOrdersBatch → checkOrders, getMyInfo → getBalance)
    }
}

// ─── Singleton factory (preserved from original file) ─────────────────────────

let _instance = null;

/**
 * Get the singleton RoyalCrownProvider instance.
 * Pass options only the first time (or use { reset: true } to recreate).
 *
 * @param {Object}  [options]
 * @param {boolean} [options.reset=false]  - force recreation
 * @returns {RoyalCrownProvider}
 */
const getRoyalCrownProvider = (options = {}) => {
    if (_instance && !options.reset) return _instance;
    _instance = new RoyalCrownProvider(options);
    return _instance;
};

module.exports = { RoyalCrownProvider, getRoyalCrownProvider, ProviderAPIError };
