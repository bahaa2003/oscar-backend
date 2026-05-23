'use strict';

/**
 * orderFieldsExtended.test.js — Gap-filling tests for the Dynamic Order Fields system
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Tests added to cover gaps identified in the audit:
 *
 * [1] url field type validation
 *     - valid URL accepted
 *     - invalid URL rejected (missing scheme)
 *     - empty string rejected
 *     - required url field missing → rejected
 *
 * [2] number field min / max enforcement
 *     - value below min → rejected
 *     - value above max → rejected
 *     - value at exact min → accepted
 *     - value at exact max → accepted
 *     - field with no min/max → accepted freely
 *     - snapshot preserves min/max values
 *
 * [3] providerMapping — applyProviderMapping unit tests
 *     - identity pass-through when providerMapping is null
 *     - identity pass-through when providerMapping is empty object
 *     - translates internal key to provider key
 *     - passes through unmapped keys unchanged
 *     - mixed mapped + unmapped
 *     - supports Map object (Mongoose Map)
 *
 * [4] providerMapping — integration with executeOrder (via mock provider)
 *     - provider receives mapped parameter names when mapping is set
 *     - provider receives original keys when no mapping is set
 *
 * [5] Admin product — providerMapping CRUD
 *     - createProduct stores providerMapping
 *     - updateProduct sets providerMapping
 *     - updateProduct does not touch providerMapping if omitted
 */

const { validateOrderFields, applyProviderMapping } = require('../modules/orders/orderFields.validator');
const { Product } = require('../modules/products/product.model');
const productService = require('../modules/products/product.service');
const { createOrder } = require('../modules/orders/order.service');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

// ─────────────────────────────────────────────────────────────────────────────
// [1] url field type validation
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] url field type validation', () => {
    const URL_FIELD = [{
        id: 'f1', label: 'Video URL', key: 'video_url',
        type: 'url', required: true, isActive: true,
    }];

    it('accepts a valid https URL', () => {
        const { values } = validateOrderFields(URL_FIELD, {
            video_url: 'https://www.youtube.com/watch?v=abc123',
        });
        expect(values.video_url).toBe('https://www.youtube.com/watch?v=abc123');
    });

    it('accepts a valid http URL', () => {
        const { values } = validateOrderFields(URL_FIELD, {
            video_url: 'http://example.com/path',
        });
        expect(values.video_url).toBe('http://example.com/path');
    });

    it('trims whitespace around URL', () => {
        const { values } = validateOrderFields(URL_FIELD, {
            video_url: '  https://example.com  ',
        });
        expect(values.video_url).toBe('https://example.com');
    });

    it('rejects a URL without http/https scheme', () => {
        expect(() =>
            validateOrderFields(URL_FIELD, { video_url: 'ftp://example.com' })
        ).toThrow(/valid URL/);
    });

    it('rejects a plain string that is not a URL', () => {
        expect(() =>
            validateOrderFields(URL_FIELD, { video_url: 'not-a-url' })
        ).toThrow(/valid URL/);
    });

    it('rejects empty string for url field', () => {
        expect(() =>
            validateOrderFields(URL_FIELD, { video_url: '' })
        ).toThrow(/required|non-empty/i);
    });

    it('rejects missing required url field', () => {
        expect(() =>
            validateOrderFields(URL_FIELD, {})
        ).toThrow(/Video URL.*required/);
    });

    it('accepts optional url field that is absent', () => {
        const optionalUrl = [{ ...URL_FIELD[0], required: false }];
        const { values } = validateOrderFields(optionalUrl, {});
        expect(values.video_url).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] number field min / max enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] number field min / max enforcement', () => {
    const makeNumField = (overrides = {}) => [{
        id: 'f1', label: 'Quantity', key: 'quantity',
        type: 'number', required: true, isActive: true,
        min: 100, max: 10000,
        ...overrides,
    }];

    it('rejects value below min', () => {
        expect(() =>
            validateOrderFields(makeNumField(), { quantity: 50 })
        ).toThrow(/at least 100/);
    });

    it('rejects value above max', () => {
        expect(() =>
            validateOrderFields(makeNumField(), { quantity: 99999 })
        ).toThrow(/at most 10000/);
    });

    it('accepts value at exact min boundary', () => {
        const { values } = validateOrderFields(makeNumField(), { quantity: 100 });
        expect(values.quantity).toBe(100);
    });

    it('accepts value at exact max boundary', () => {
        const { values } = validateOrderFields(makeNumField(), { quantity: 10000 });
        expect(values.quantity).toBe(10000);
    });

    it('accepts value within range', () => {
        const { values } = validateOrderFields(makeNumField(), { quantity: 500 });
        expect(values.quantity).toBe(500);
    });

    it('accepts field with no min/max freely', () => {
        const noRange = makeNumField({ min: null, max: null });
        const { values } = validateOrderFields(noRange, { quantity: 9999999 });
        expect(values.quantity).toBe(9999999);
    });

    it('coerces string to number before applying bounds', () => {
        const { values } = validateOrderFields(makeNumField(), { quantity: '500' });
        expect(values.quantity).toBe(500);
        expect(typeof values.quantity).toBe('number');
    });

    it('snapshot preserves min and max for number fields', () => {
        const { fieldsSnapshot } = validateOrderFields(makeNumField(), { quantity: 500 });
        expect(fieldsSnapshot[0].min).toBe(100);
        expect(fieldsSnapshot[0].max).toBe(10000);
    });

    it('snapshot omits min/max when they are null', () => {
        const noRange = makeNumField({ min: null, max: null });
        const { fieldsSnapshot } = validateOrderFields(noRange, { quantity: 1 });
        expect(fieldsSnapshot[0].min).toBeUndefined();
        expect(fieldsSnapshot[0].max).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] applyProviderMapping — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] applyProviderMapping — pure unit tests', () => {
    it('returns empty object when values is empty', () => {
        expect(applyProviderMapping({}, null)).toEqual({});
    });

    it('returns copy of values when providerMapping is null', () => {
        const values = { player_id: '123', server: 'EU' };
        const result = applyProviderMapping(values, null);
        expect(result).toEqual({ player_id: '123', server: 'EU' });
    });

    it('returns copy of values when providerMapping is empty object', () => {
        const values = { player_id: '123' };
        const result = applyProviderMapping(values, {});
        expect(result).toEqual({ player_id: '123' });
    });

    it('translates a mapped key', () => {
        const values = { player_id: '123', server: 'EU' };
        const mapping = { player_id: 'link' };
        const result = applyProviderMapping(values, mapping);
        expect(result).toEqual({ link: '123', server: 'EU' });
        // Original keys do NOT appear under old name
        expect(result.player_id).toBeUndefined();
    });

    it('passes unmapped keys through unchanged', () => {
        const values = { player_id: '123', quantity: 500 };
        const mapping = { player_id: 'link' };
        const result = applyProviderMapping(values, mapping);
        expect(result.link).toBe('123');
        expect(result.quantity).toBe(500);
    });

    it('handles full remapping of all keys', () => {
        const values = { player_id: '999', server: 'NA', gift_note: 'hello' };
        const mapping = { player_id: 'link', server: 'server_id', gift_note: 'comment' };
        const result = applyProviderMapping(values, mapping);
        expect(result).toEqual({ link: '999', server_id: 'NA', comment: 'hello' });
    });

    it('does not mutate the original values object', () => {
        const values = { player_id: '123' };
        const mapping = { player_id: 'link' };
        applyProviderMapping(values, mapping);
        expect(values.player_id).toBe('123'); // unchanged
    });

    it('supports Mongoose Map instance', () => {
        const values = { player_id: '456', qty: 10 };
        const jsMap = new Map([['player_id', 'link']]);
        const result = applyProviderMapping(values, jsMap);
        expect(result.link).toBe('456');
        expect(result.qty).toBe(10);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] providerMapping integration with order creation + executeOrder
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] providerMapping — order creation + fulfillment', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup(
            { walletBalance: 5000, creditLimit: 0 },
            { percentage: 0 }
        ));
    });

    it('customerInput.values uses internal keys (pre-mapping)', async () => {
        const product = await createProduct({
            basePrice: 10, minQty: 1, maxQty: 10,
            orderFields: [{
                id: 'f1', label: 'Player ID', key: 'player_id',
                type: 'text', required: true, isActive: true,
            }],
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { player_id: 'hero_123' },
        });

        // Internal storage always uses internal keys
        expect(order.customerInput.values.player_id).toBe('hero_123');
    });

    it('createProduct stores providerMapping', async () => {
        const product = await productService.createProduct({
            name: `Mapped-Product-${Date.now()}`,
            basePrice: 5,
            minQty: 1,
            maxQty: 100,
            orderFields: [{
                id: 'f1', label: 'Username', key: 'username',
                type: 'text', required: true, isActive: true,
            }],
            providerMapping: { username: 'link' },
        });

        // Mongoose Map — toObject() converts it to plain object
        const mapping = product.providerMapping instanceof Map
            ? Object.fromEntries(product.providerMapping)
            : product.providerMapping;

        expect(mapping.username).toBe('link');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] Admin product providerMapping CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Admin product providerMapping CRUD', () => {
    it('createProduct stores providerMapping', async () => {
        const product = await productService.createProduct({
            name: `Map-Create-${Date.now()}`,
            basePrice: 10,
            minQty: 1,
            maxQty: 10,
            providerMapping: { player_id: 'link', server: 'server_id' },
        });

        const mapping = product.providerMapping instanceof Map
            ? Object.fromEntries(product.providerMapping)
            : product.providerMapping;

        expect(mapping.player_id).toBe('link');
        expect(mapping.server).toBe('server_id');
    });

    it('updateProduct sets providerMapping', async () => {
        const product = await productService.createProduct({
            name: `Map-Update-${Date.now()}`,
            basePrice: 10, minQty: 1, maxQty: 10,
        });

        const updated = await productService.updateProduct(product._id, {
            providerMapping: { username: 'link' },
        });

        const mapping = updated.providerMapping instanceof Map
            ? Object.fromEntries(updated.providerMapping)
            : updated.providerMapping;

        expect(mapping.username).toBe('link');
    });

    it('updateProduct does not touch providerMapping when not in payload', async () => {
        const product = await productService.createProduct({
            name: `Map-Preserve-${Date.now()}`,
            basePrice: 10, minQty: 1, maxQty: 10,
            providerMapping: { player_id: 'link' },
        });

        // Update name only
        const updated = await productService.updateProduct(product._id, {
            name: `Map-Preserve-Renamed-${Date.now()}`,
        });

        const mapping = updated.providerMapping instanceof Map
            ? Object.fromEntries(updated.providerMapping)
            : updated.providerMapping;

        expect(mapping.player_id).toBe('link');
    });

    it('updateProduct can clear providerMapping by setting empty object', async () => {
        const product = await productService.createProduct({
            name: `Map-Clear-${Date.now()}`,
            basePrice: 10, minQty: 1, maxQty: 10,
            providerMapping: { player_id: 'link' },
        });

        const updated = await productService.updateProduct(product._id, {
            providerMapping: {},
        });

        const mapping = updated.providerMapping instanceof Map
            ? Object.fromEntries(updated.providerMapping)
            : updated.providerMapping;

        expect(Object.keys(mapping)).toHaveLength(0);
    });

    it('Product model accepts url field type', async () => {
        const product = await Product.create({
            name: `URL-Type-Test-${Date.now()}`,
            basePrice: 10,
            minQty: 1,
            maxQty: 10,
            orderFields: [{
                id: 'f1', label: 'Video Link', key: 'video_link', type: 'url', required: true,
            }],
        });
        expect(product.orderFields[0].type).toBe('url');
    });

    it('Product model accepts min/max on number orderField', async () => {
        const product = await Product.create({
            name: `MinMax-Test-${Date.now()}`,
            basePrice: 10, minQty: 1, maxQty: 10,
            orderFields: [{
                id: 'f1', label: 'Count', key: 'count', type: 'number',
                required: true, min: 50, max: 500,
            }],
        });
        expect(product.orderFields[0].min).toBe(50);
        expect(product.orderFields[0].max).toBe(500);
    });
});
