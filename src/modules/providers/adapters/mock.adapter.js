'use strict';

const { BaseProviderAdapter } = require('./base.adapter');

/**
 * MockProviderAdapter
 *
 * Used in tests and local development.
 * Returns a configurable set of DTOs / responses without making any HTTP calls.
 *
 * All methods are individually overridable via the options object passed to
 * the constructor, making it easy to mock specific scenarios per test.
 *
 * Usage in tests — inject products:
 *   const adapter = new MockProviderAdapter(provider, {
 *     products: [{ externalProductId: 'P1', rawName: 'Widget', rawPrice: 10, ... }]
 *   });
 *
 * Usage in tests — inject order responses:
 *   const adapter = new MockProviderAdapter(provider, {
 *     placeOrderResult: { success: true, providerOrderId: 42, providerStatus: 'Pending', ... }
 *   });
 *
 * Usage as default (when no real adapter is registered for a provider):
 *   Returns a hard-coded sample catalogue, empty order results.
 */
class MockProviderAdapter extends BaseProviderAdapter {
    /**
     * @param {Object}  provider
     * @param {Object}  [options]
     * @param {Array}   [options.products]          - override product catalogue
     * @param {Error}   [options.shouldThrow]        - if set, getProducts() throws this
     * @param {Object}  [options.placeOrderResult]   - override placeOrder() return value
     * @param {Object}  [options.checkOrderResult]   - override checkOrder() return value
     * @param {Array}   [options.checkOrdersResult]  - override checkOrders() return value
     * @param {Object}  [options.balanceResult]      - override getBalance() return value
     */
    constructor(provider, options = {}) {
        super(provider, options);
        this._products = options.products ?? null;
        this._shouldThrow = options.shouldThrow ?? null;
        this._placeOrderResult = options.placeOrderResult ?? null;
        this._checkOrderResult = options.checkOrderResult ?? null;
        this._checkOrdersResult = options.checkOrdersResult ?? null;
        this._balanceResult = options.balanceResult ?? null;
    }

    // ── Products ──────────────────────────────────────────────────────────────

    async getProducts() {
        if (this._shouldThrow) throw this._shouldThrow;
        const raw = this._products ?? MockProviderAdapter.sampleProducts();
        return raw.map((p) => this._validateDTO(p));
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    async placeOrder(params) {
        if (this._placeOrderResult) return this._placeOrderResult;
        return {
            success: true,
            providerOrderId: 99001,
            providerStatus: 'Pending',
            rawResponse: { mock: true, params },
            errorMessage: null,
        };
    }

    async checkOrder(orderId) {
        if (this._checkOrderResult) return this._checkOrderResult;
        return {
            providerOrderId: parseInt(String(orderId), 10),
            providerStatus: 'Pending',
            rawResponse: { mock: true, orderId },
        };
    }

    async checkOrders(orderIds) {
        if (this._checkOrdersResult) return this._checkOrdersResult;
        return (orderIds ?? []).map((id) => ({
            providerOrderId: parseInt(String(id), 10),
            providerStatus: 'Pending',
            rawResponse: { mock: true },
        }));
    }

    // ── Account ────────────────────────────────────────────────────────────────

    async getBalance() {
        return this._balanceResult ?? { balance: 9999.00, currency: 'USD', mock: true };
    }

    // ── Static sample data ────────────────────────────────────────────────────

    /**
     * Returns a stable sample product catalogue.
     * Each property maps directly to the DTO contract.
     */
    static sampleProducts() {
        return [
            {
                externalProductId: 'PROD-001',
                rawName: 'Provider Widget A',
                rawPrice: 25.00,
                minQty: 1,
                maxQty: 500,
                isActive: true,
                rawPayload: { id: 'PROD-001', name: 'Provider Widget A', price: 25.00 },
            },
            {
                externalProductId: 'PROD-002',
                rawName: 'Provider Gadget B',
                rawPrice: 99.99,
                minQty: 1,
                maxQty: 50,
                isActive: true,
                rawPayload: { id: 'PROD-002', name: 'Provider Gadget B', price: 99.99 },
            },
            {
                externalProductId: 'PROD-003',
                rawName: 'Provider Item C (inactive)',
                rawPrice: 10.00,
                minQty: 5,
                maxQty: 100,
                isActive: false,
                rawPayload: { id: 'PROD-003', name: 'Provider Item C', price: 10.00, active: false },
            },
        ];
    }
}

module.exports = { MockProviderAdapter };
