'use strict';

/**
 * RoyalCrownAdapter
 *
 * Real HTTP adapter for the Royal Crown external provider.
 *
 * All network calls use axios with:
 *   - api-token header (from provider.apiToken / provider.apiKey)
 *   - configurable timeout (default 15 s)
 *   - structured error wrapping so upstream failures never leak raw axios errors
 *
 * Provider API spec:
 *   Base URL       : provider.baseUrl  (e.g. https://royal-croown.com)
 *   Auth header    : api-token: <token>
 *
 *   GET  /api/api/AllProducts                       — fetch product catalogue
 *   GET  /api/PlaceOrder/{productId}/data
 *              ?amount={amount}
 *              &player_Id={playerId}
 *              &referenceId={referenceId}            — place an order
 *   GET  /api/CheckOrder?order_id={orderId}          — check single order
 *   GET  /api/CheckListOrders?orders=[1,2,3]         — batch check
 *   GET  /api/GetMyInfo                              — account / balance info
 *
 * Normalised output shapes:
 *   getProducts()  → ProviderProductDTO[]
 *   placeOrder()   → PlaceOrderResult
 *   checkOrder()   → OrderStatusResult
 *   checkOrders()  → OrderStatusResult[]
 *   getBalance()   → Object
 *
 * PlaceOrderResult:
 *   { success, providerOrderId, providerStatus, rawResponse, errorMessage }
 *
 * OrderStatusResult:
 *   { providerOrderId, providerStatus, rawResponse }
 *
 * Status mapping (provider → platform):
 *   Completed  → 'Completed'  (passes through — statusMapper converts to ORDER_STATUS)
 *   Pending    → 'Pending'
 *   Cancelled  → 'Cancelled'
 */

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

const DEFAULT_TIMEOUT_MS = 180_000;

// ─── HTTP client factory ──────────────────────────────────────────────────────

/**
 * Build a pre-configured axios instance for the Royal Crown API.
 *
 * @param {string} baseURL
 * @param {string} token
 * @param {number} [timeoutMs]
 * @returns {import('axios').AxiosInstance}
 */
const _buildAxiosClient = (baseURL, token, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const client = axios.create({
        baseURL,
        timeout: timeoutMs,
        headers: {
            'api-token': token,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    });

    // Response interceptor — convert AxiosError into a plain Error so
    // callers never deal with internal axios structures.
    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = body?.message ?? body?.error ?? err.message ?? 'Unknown provider error';
            const wrapped = new Error(`[RoyalCrown] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

// ─── ProviderAPIError ─────────────────────────────────────────────────────────

/**
 * Thrown when the provider API explicitly indicates failure via
 * `success: false` in its response body.
 */
class ProviderAPIError extends Error {
    /**
     * @param {string} message
     * @param {Object} [rawResponse]
     */
    constructor(message, rawResponse = null) {
        super(message);
        this.name = 'ProviderAPIError';
        this.rawResponse = rawResponse;
    }
}

// ─── RoyalCrownAdapter ────────────────────────────────────────────────────────

class RoyalCrownAdapter extends BaseProviderAdapter {
    /**
     * @param {Object} provider          - Provider Mongoose document
     * @param {string} provider.baseUrl
     * @param {string} [provider.apiToken]
     * @param {string} [provider.apiKey]  - legacy alias
     * @param {Object} [options]
     * @param {number} [options.timeoutMs] - override default 15 s timeout
     */
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[RoyalCrown] provider.baseUrl is required');
        if (!token) throw new Error('[RoyalCrown] api token (apiToken / apiKey) is required');

        this._client = _buildAxiosClient(provider.baseUrl, token, options.timeoutMs);
    }

    // ── Product Catalogue ─────────────────────────────────────────────────────

    /**
     * GET /api/api/AllProducts
     *
     * Returns normalised ProviderProductDTOs.
     *
     * Expected response shapes (provider may return several variants):
     *   [ { id, name, rate, min, max }, ... ]          – plain array
     *   { data: [...] }                                 – wrapped in .data
     *   { products: [...] }                             – wrapped in .products
     *
     * @returns {Promise<ProviderProductDTO[]>}
     */
    async getProducts() {
        const { data } = await this._client.get('/api/AllProducts');
        const list = Array.isArray(data)
            ? data
            : (data.data ?? data.products ?? data.services ?? []);

        return list.map((item) => this._validateDTO({
            externalProductId: String(item.id ?? item.product_id ?? item.service ?? item.code),
            rawName: String(item.name ?? item.product_name ?? item.product_name_translated ?? item.title ?? item.service_name ?? 'Unknown'),
            rawPrice: String(item.rate ?? item.price ?? item.product_price ?? item.cost ?? 0),
            minQty: parseInt(item.min ?? item.min_qty ?? item.min_quantity ?? 1, 10),
            maxQty: parseInt(item.max ?? item.max_qty ?? item.max_quantity ?? 9999, 10),
            isActive: item.active !== false && item.is_active !== false && item.status !== 'inactive' && item.status !== 'Inactive',
            rawPayload: item,
        }));
    }

    // ── Order Placement ───────────────────────────────────────────────────────

    /**
     * GET /api/PlaceOrder/{productId}/data
     *       ?amount={amount}
     *       &player_Id={playerId}
     *       &referenceId={referenceId}
     *
     * placeOrder() NEVER throws — failures are returned as { success: false }.
     * This is the contract expected by orderFulfillment.service.js.
     *
     * Accepts both legacy param names (externalProductId/quantity) and new
     * canonical names (productId/amount) for backward compatibility.
     *
     * @param {Object}        params
     * @param {string|number} params.productId        - provider's product ID
     * @param {number}        params.amount            - order quantity / units
     * @param {string}        [params.playerId]        - player / account ID
     * @param {string}        [params.referenceId]     - our internal reference
     * @param {string|number} [params.externalProductId] - alias for productId
     * @param {number}        [params.quantity]           - alias for amount
     *
     * @returns {Promise<PlaceOrderResult>}
     */
    async placeOrder(params) {
        const productId = params.productId ?? params.externalProductId;
        const amount = params.amount ?? params.quantity;
        const playerId = params.playerId ?? '';
        const referenceId = params.referenceId ?? '';

        try {
            const { data } = await this._client.get(
                `/api/PlaceOrder/${encodeURIComponent(productId)}/data`,
                {
                    params: {
                        amount,
                        player_Id: playerId,
                        referenceId,
                    },
                }
            );

            // ── Normalise response structure ────────────────────────────────
            // Some providers wrap everything inside a `data` sub-object:
            //   { success: true, data: { order_id: 301069, order_status: 'Completed' } }
            // Others return flat:
            //   { order: 123, status: 'Pending' }
            // We handle both by checking nested first, then flat.
            const nested = data.data ?? {};   // the inner data wrapper (if any)

            // ── Success check ────────────────────────────────────────────────
            // Provider may signal failure at either level
            const isSuccess = data.success !== false && nested.success !== false;

            if (!isSuccess) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: nested.message ?? data.message ?? nested.error ?? data.error ?? 'Provider rejected the order',
                };
            }

            // ── Extract order ID ─────────────────────────────────────────────
            // Check nested data first (data.data.order_id), then flat fields
            const providerOrderId =
                nested.order_id ?? nested.orderId ?? nested.order ?? nested.id ??
                data.order_id   ?? data.orderId   ?? data.order   ?? data.id   ??
                null;

            if (!providerOrderId) {
                // HTTP 200 + success: true but no order ID → logical failure
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: nested.error ?? data.error ?? nested.message ?? data.message ?? 'Provider returned no order ID',
                };
            }

            // ── Extract status ───────────────────────────────────────────────
            const providerStatus =
                nested.order_status ?? nested.status ??
                data.order_status   ?? data.status   ??
                'Pending';

            return {
                success: true,
                providerOrderId: parseInt(String(providerOrderId), 10),
                providerStatus,
                rawResponse: data,
                errorMessage: null,
            };

        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: err.providerBody ?? { message: err.message },
                errorMessage: err.message,
            };
        }
    }

    // ── Order Status ──────────────────────────────────────────────────────────

    /**
     * GET /api/CheckOrder?order_id={orderId}
     *
     * Checks the current status of a single provider order.
     *
     * Expected response shape:
     *   { status: 'Pending', charge: '1.50', remains: '100', ... }
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     */
    async checkOrder(orderId) {
        const endpoint = '/api/CheckOrder';
        const params = { order_id: orderId };



        const { data } = await this._client.get(endpoint, { params });



        // ── Normalise nested response ────────────────────────────────────
        // Provider may return: { success: true, data: { order_id, order_status, ... } }
        // or flat:             { status: 'Pending', charge: '1.50', ... }
        const nested = data.data ?? {};

        const providerStatus =
            nested.order_status ?? nested.status ??
            data.order_status   ?? data.status   ??
            'Pending';

        const resolvedOrderId =
            nested.order_id ?? nested.orderId ??
            data.order_id   ?? data.orderId   ??
            orderId;

        return {
            providerOrderId: parseInt(String(resolvedOrderId), 10),
            providerStatus,
            unifiedStatus: this.toUnifiedStatus(providerStatus),
            rawResponse: data,
        };
    }

    /**
     * GET /api/CheckListOrders?orders=[1,2,3]
     *
     * Batch status check — more efficient than N×checkOrder().
     *
     * Expected response shape (object map):
     *   {
     *     "12345": { status: "Completed", charge: "2.00", ... },
     *     "12346": { status: "Pending",   charge: "1.50", ... }
     *   }
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     */
    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];

        const { data } = await this._client.get('/api/CheckListOrders', {
            params: { orders: JSON.stringify(orderIds) },
        });

        // Normalise object-map → array
        return Object.entries(data).map(([id, item]) => ({
            providerOrderId: parseInt(id, 10),
            providerStatus: item.status ?? 'Pending',
            rawResponse: item,
        }));
    }

    // ── Account / Balance ─────────────────────────────────────────────────────

    /**
     * GET /api/GetMyInfo
     *
     * Returns account details (balance, plan, username, etc.).
     *
     * @returns {Promise<Object>} raw provider response body
     */
    async getBalance() {
        const { data } = await this._client.get('/api/GetMyInfo');
        return data;
    }
}

module.exports = { RoyalCrownAdapter, ProviderAPIError };
