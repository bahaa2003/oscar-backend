'use strict';

/**
 * ibra.adapter.js - IbraAdapter
 *
 * HTTP adapter for Ibra Store's B2B API.
 *
 * Base URL : provider.baseUrl
 * Auth     : api-token: <token>
 *
 * GET  /client/profile
 * GET  /client/products
 * POST /client/orders
 * GET  /client/check?orders=uuid1,id2
 */

const axios = require('axios');
const crypto = require('crypto');
const { BaseProviderAdapter } = require('./base.adapter');

const DEFAULT_TIMEOUT_MS = 180_000;
const PROVIDER_NAME = 'Ibra';

const KNOWN_PLACE_ORDER_KEYS = new Set([
    'productId',
    'externalProductId',
    'amount',
    'quantity',
    'qty',
    'referenceId',
    'orderUuid',
    'order_uuid',
]);

const ERROR_MESSAGES = Object.freeze({
    100: 'Insufficient provider balance.',
    101: 'Invalid or missing API token.',
    102: 'Invalid product ID.',
    103: 'Invalid quantity.',
    104: 'Product is unavailable.',
    105: 'Missing required order fields.',
    106: 'Duplicate order UUID.',
    120: 'Provider rejected the order request.',
});

const isPlainObject = (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
);

const unwrap = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (!isPlainObject(payload)) return payload;
    return payload.data ?? payload.result ?? payload;
};

const getErrorCode = (payload) => {
    const source = isPlainObject(payload?.data) ? payload.data : payload;
    const rawCode = source?.code
        ?? source?.error_code
        ?? source?.errorCode
        ?? source?.status_code
        ?? source?.statusCode;
    const code = Number(rawCode);
    return Number.isFinite(code) ? code : null;
};

const getErrorMessage = (payload, fallback = 'Provider rejected the request.') => {
    const source = isPlainObject(payload?.data) ? payload.data : payload;
    const code = getErrorCode(payload);

    return source?.message
        || source?.error
        || source?.error_message
        || source?.errorMessage
        || ERROR_MESSAGES[code]
        || fallback;
};

const isFailurePayload = (payload) => {
    const source = isPlainObject(payload?.data) ? payload.data : payload;
    const code = getErrorCode(payload);

    return source?.success === false
        || source?.ok === false
        || source?.status === false
        || source?.status === 'error'
        || source?.error
        || (code !== null && code !== 0 && code !== 200);
};

const normalizeStatus = (status) => {
    const value = String(status || '').trim().toLowerCase();
    if (['completed', 'complete', 'done', 'success', 'accepted', 'accept', 'ok'].includes(value)) {
        return 'Completed';
    }
    if (['cancelled', 'canceled', 'failed', 'error', 'rejected', 'reject', 'refunded'].includes(value)) {
        return 'Cancelled';
    }
    return status || 'Pending';
};

const buildClient = (baseURL, token, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const client = axios.create({
        baseURL,
        timeout: timeoutMs,
        headers: {
            'api-token': token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = getErrorMessage(body, err.message || 'Unknown provider error');
            const wrapped = new Error(`[${PROVIDER_NAME}] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

class IbraAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[Ibra] provider.baseUrl is required');
        if (!token) throw new Error('[Ibra] api token (apiToken / apiKey) is required');

        this._client = buildClient(provider.baseUrl, token, options.timeoutMs);
    }

    /**
     * GET /client/products
     *
     * Provider shape:
     *   [ { id, name, price, ... }, ... ]
     */
    async getProducts() {
        const { data } = await this._client.get('/client/products');
        const payload = unwrap(data);
        const list = Array.isArray(payload)
            ? payload
            : (payload.products ?? payload.items ?? payload.services ?? []);

        return list.map((item) => this._validateDTO({
            externalProductId: String(item.id ?? item.productId ?? item.product_id),
            rawName: String(item.name ?? item.title ?? item.product_name ?? 'Unknown'),
            rawPrice: String(item.price ?? item.rate ?? item.cost ?? 0),
            minQty: parseInt(item.minQty ?? item.min_qty ?? item.min ?? 1, 10),
            maxQty: parseInt(item.maxQty ?? item.max_qty ?? item.max ?? 9999, 10),
            isActive: item.isActive !== false
                && item.active !== false
                && !['inactive', 'disabled', 'off'].includes(String(item.status || '').toLowerCase()),
            rawPayload: item,
        }));
    }

    /**
     * POST /client/orders
     *
     * Sends JSON:
     *   { productId, qty, order_uuid, ...dynamicFields }
     *
     * placeOrder() does not throw for provider rejections; it returns
     * { success: false } so fulfillment can mark/refund safely.
     */
    async placeOrder(params = {}) {
        const productId = params.productId ?? params.externalProductId;
        const qty = params.qty ?? params.quantity ?? params.amount;
        const orderUuid = params.order_uuid
            ?? params.orderUuid
            ?? params.referenceId
            ?? crypto.randomUUID();

        const dynamicFields = Object.fromEntries(
            Object.entries(params).filter(([key, value]) => (
                !KNOWN_PLACE_ORDER_KEYS.has(key)
                && value !== undefined
                && value !== null
                && value !== ''
            ))
        );

        const payload = {
            productId,
            qty,
            order_uuid: orderUuid,
            ...dynamicFields,
        };

        try {
            const { data } = await this._client.post('/client/orders', payload);
            const body = unwrap(data);

            if (isFailurePayload(data) || isFailurePayload(body)) {
                const code = getErrorCode(data) ?? getErrorCode(body);
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorCode: code,
                    errorMessage: getErrorMessage(data, 'Provider rejected the order.'),
                };
            }

            const providerOrderId = body.order_id
                ?? body.orderId
                ?? body.id
                ?? data.order_id
                ?? data.orderId
                ?? data.id
                ?? orderUuid;

            const providerStatus = normalizeStatus(
                body.status
                ?? body.order_status
                ?? data.status
                ?? data.order_status
                ?? 'Pending'
            );

            return {
                success: true,
                providerOrderId: String(providerOrderId),
                providerStatus,
                rawResponse: data,
                errorMessage: null,
                price: body.price ?? data.price ?? null,
            };
        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: err.providerBody ?? { message: err.message },
                errorCode: getErrorCode(err.providerBody),
                errorMessage: err.message,
            };
        }
    }

    /**
     * GET /client/check?orders=uuid1,id2
     */
    async checkOrder(orderId) {
        const [status] = await this.checkOrders([orderId]);

        return status ?? {
            providerOrderId: String(orderId),
            providerStatus: 'Pending',
            unifiedStatus: this.toUnifiedStatus('Pending'),
            rawResponse: null,
        };
    }

    async checkOrders(orderIds = []) {
        const ids = orderIds.map((id) => String(id).trim()).filter(Boolean);
        if (!ids.length) return [];

        const { data } = await this._client.get('/client/check', {
            params: { orders: ids.join(',') },
        });

        const payload = unwrap(data);
        const list = Array.isArray(payload)
            ? payload
            : (payload.orders ?? payload.items ?? payload.data ?? []);

        return list.map((item) => {
            const providerOrderId = item.order_id
                ?? item.orderId
                ?? item.id
                ?? item.uuid
                ?? item.order_uuid;
            const providerStatus = normalizeStatus(item.status ?? item.order_status ?? 'Pending');

            return {
                providerOrderId: String(providerOrderId),
                providerStatus,
                unifiedStatus: this.toUnifiedStatus(providerStatus),
                rawResponse: item,
            };
        });
    }

    async checkOrderStatus(orderId) {
        return this.checkOrder(orderId);
    }

    async checkOrdersStatus(orderIds = []) {
        return this.checkOrders(orderIds);
    }

    /**
     * GET /client/profile
     *
     * Provider shape:
     *   { balance, currency, email }
     */
    async getBalance() {
        const { data } = await this._client.get('/client/profile');
        const profile = unwrap(data);

        return {
            balance: profile.balance,
            currency: profile.currency,
            email: profile.email,
            rawResponse: data,
        };
    }
}

module.exports = { IbraAdapter };
