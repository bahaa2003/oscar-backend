'use strict';

/**
 * orderFields.test.js — Dynamic Order Fields System Test Suite
 * ─────────────────────────────────────────────────────────────
 *
 * [1] validateOrderFields() — pure validator unit tests
 *   - Returns empty values + snapshot for product with no orderFields
 *   - Validates required text field
 *   - Validates required number field (coerces string "42" → 42)
 *   - Validates required select field (value must be in options)
 *   - Rejects unknown field keys
 *   - Rejects missing required field
 *   - Rejects wrong type for number
 *   - Rejects select value not in options
 *   - Accepts optional field when absent
 *   - Skips inactive fields entirely
 *   - Snapshot includes only active fields with correct shape
 *   - Snapshot for select includes options array
 *   - Multiple validation errors are collected before throwing
 *
 * [2] Product Model — orderFields schema
 *   - Creates product without orderFields (defaults to empty array)
 *   - Creates product with valid orderFields (text + select)
 *   - Rejects orderField missing required key (label)
 *   - Rejects orderField with invalid type enum
 *   - Rejects orderField key that is not snake_case
 *   - Accepts all supported field types
 *
 * [3] Order creation with orderFields
 *   - Product with no orderFields accepts order without orderFieldsValues
 *   - Product with required field accepts valid orderFieldsValues
 *   - customerInput.values stored correctly on order
 *   - customerInput.fieldsSnapshot stored correctly on order
 *   - Order rejected with INVALID_ORDER_FIELDS when required field missing
 *   - Order rejected with INVALID_ORDER_FIELDS for unknown field key
 *   - Order rejected with INVALID_ORDER_FIELDS for wrong select value
 *   - customerInput is null when product has no orderFields
 *   - Snapshot is immutable: admin changes to product.orderFields do not alter stored order
 *   - Optional field absent from submission: order is accepted and values map omits the key
 *
 * [4] Admin product API — orderFields management
 *   - createProduct persists orderFields
 *   - updateProduct replaces orderFields
 *   - updateProduct does not touch orderFields when not in payload
 */

const mongoose = require('mongoose');
const { Product, FIELD_TYPES } = require('../modules/products/product.model');
const { Order } = require('../modules/orders/order.model');
const { validateOrderFields } = require('../modules/orders/orderFields.validator');
const { createOrder } = require('../modules/orders/order.service');
const productService = require('../modules/products/product.service');

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

// ── Shared field definitions ──────────────────────────────────────────────────

const FIELDS = [
    {
        id: 'field_1',
        label: 'Player ID',
        key: 'player_id',
        type: 'text',
        placeholder: 'Enter your player ID',
        required: true,
        sortOrder: 1,
        isActive: true,
    },
    {
        id: 'field_2',
        label: 'Server',
        key: 'server',
        type: 'select',
        required: true,
        options: ['EU', 'NA', 'Middle East'],
        sortOrder: 2,
        isActive: true,
    },
    {
        id: 'field_3',
        label: 'Gift Note',
        key: 'gift_note',
        type: 'textarea',
        required: false,
        sortOrder: 3,
        isActive: true,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// [1] validateOrderFields — pure unit tests (no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] validateOrderFields() — pure validator', () => {
    it('returns empty values + empty snapshot for product with no orderFields', () => {
        const result = validateOrderFields([], {});
        expect(result.values).toEqual({});
        expect(result.fieldsSnapshot).toEqual([]);
    });

    it('validates and stores a required text field', () => {
        const { values } = validateOrderFields(
            [FIELDS[0]],
            { player_id: '  123456789  ' }
        );
        expect(values.player_id).toBe('123456789'); // trimmed
    });

    it('coerces string numeric input to a number for type=number', () => {
        const fields = [{
            id: 'f1', label: 'Amount', key: 'amount',
            type: 'number', required: true, isActive: true,
        }];
        const { values } = validateOrderFields(fields, { amount: '42' });
        expect(values.amount).toBe(42);
        expect(typeof values.amount).toBe('number');
    });

    it('accepts a native number for type=number', () => {
        const fields = [{
            id: 'f1', label: 'Count', key: 'count',
            type: 'number', required: true, isActive: true,
        }];
        const { values } = validateOrderFields(fields, { count: 7 });
        expect(values.count).toBe(7);
    });

    it('accepts valid select value', () => {
        const { values } = validateOrderFields(
            [FIELDS[1]],
            { server: 'EU' }
        );
        expect(values.server).toBe('EU');
    });

    it('throws INVALID_ORDER_FIELDS for unknown field key', () => {
        expect(() =>
            validateOrderFields(FIELDS, { player_id: '123', server: 'EU', hacked: 'x' })
        ).toThrow(/Unknown order field/);
    });

    it('throws INVALID_ORDER_FIELDS when required field is missing', () => {
        expect(() =>
            validateOrderFields(FIELDS, { server: 'EU' })  // player_id missing
        ).toThrow(/Player ID.*required/);
    });

    it('throws INVALID_ORDER_FIELDS for non-numeric value in type=number field', () => {
        const fields = [{
            id: 'f1', label: 'Amount', key: 'amount',
            type: 'number', required: true, isActive: true,
        }];
        expect(() =>
            validateOrderFields(fields, { amount: 'not-a-number' })
        ).toThrow(/INVALID_ORDER_FIELDS|valid number/);
    });

    it('throws INVALID_ORDER_FIELDS when select value is not in options', () => {
        expect(() =>
            validateOrderFields(FIELDS, { player_id: '123', server: 'INVALID_REGION' })
        ).toThrow(/INVALID_ORDER_FIELDS|must be one of/);
    });

    it('accepts order when optional field is absent', () => {
        // FIELDS[2] (gift_note) is optional
        const { values } = validateOrderFields(
            FIELDS,
            { player_id: '123', server: 'NA' }
        );
        expect(values.gift_note).toBeUndefined();
        expect(values.player_id).toBe('123');
        expect(values.server).toBe('NA');
    });

    it('skips inactive fields — does not validate and does not appear in snapshot', () => {
        const inactiveField = { ...FIELDS[0], isActive: false, required: true };
        // Submitting nothing for player_id should NOT throw, since field is inactive
        const { values, fieldsSnapshot } = validateOrderFields(
            [inactiveField, FIELDS[1]],
            { server: 'EU' }
        );
        expect(Object.keys(values)).toContain('server');
        expect(Object.keys(values)).not.toContain('player_id');
        expect(fieldsSnapshot.map((f) => f.key)).not.toContain('player_id');
    });

    it('snapshot contains key, label, type for each active field', () => {
        const { fieldsSnapshot } = validateOrderFields(
            [FIELDS[0], FIELDS[1]],
            { player_id: '123', server: 'EU' }
        );
        expect(fieldsSnapshot).toHaveLength(2);
        expect(fieldsSnapshot[0]).toMatchObject({ key: 'player_id', label: 'Player ID', type: 'text' });
        expect(fieldsSnapshot[1]).toMatchObject({ key: 'server', label: 'Server', type: 'select' });
    });

    it('snapshot for select field includes options array', () => {
        const { fieldsSnapshot } = validateOrderFields([FIELDS[1]], { server: 'EU' });
        expect(fieldsSnapshot[0].options).toEqual(['EU', 'NA', 'Middle East']);
    });

    it('collects multiple errors before throwing a single exception', () => {
        // player_id missing AND gift_note receives a number (wrong type for textarea)
        // Only the required-check throws on player_id; gift_note is optional so
        // passing no value is fine. Let's test two distinct required fields.
        const twoRequired = [FIELDS[0], FIELDS[1]]; // both required
        const err = (() => {
            try {
                validateOrderFields(twoRequired, {}); // both missing
            } catch (e) {
                return e;
            }
        })();
        expect(err.code).toBe('INVALID_ORDER_FIELDS');
        // Both field errors should appear in the message
        expect(err.message).toContain('Player ID');
        expect(err.message).toContain('Server');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] Product Model — orderFields schema
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] Product Model — orderFields schema', () => {
    const makeProduct = (extra = {}) =>
        Product.create({
            name: `Test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            basePrice: 10.00,
            minQty: 1,
            maxQty: 100,
            ...extra,
        });

    it('defaults orderFields to an empty array', async () => {
        const p = await makeProduct();
        expect(Array.isArray(p.orderFields)).toBe(true);
        expect(p.orderFields).toHaveLength(0);
    });

    it('creates product with valid orderFields (text + select)', async () => {
        const p = await makeProduct({ orderFields: FIELDS });
        expect(p.orderFields).toHaveLength(3);
        expect(p.orderFields[0].key).toBe('player_id');
        expect(p.orderFields[1].type).toBe('select');
        expect(p.orderFields[1].options).toEqual(['EU', 'NA', 'Middle East']);
    });

    it('rejects orderField without required id', async () => {
        await expect(
            makeProduct({
                orderFields: [{ label: 'X', key: 'x', type: 'text' }] // id missing
            })
        ).rejects.toThrow(/orderField\.id is required/);
    });

    it('rejects orderField without required label', async () => {
        await expect(
            makeProduct({
                orderFields: [{ id: 'f1', key: 'x', type: 'text' }]
            })
        ).rejects.toThrow(/orderField\.label is required/);
    });

    it('rejects orderField with invalid type enum', async () => {
        await expect(
            makeProduct({
                orderFields: [{ id: 'f1', label: 'X', key: 'x', type: 'invalid_type' }]
            })
        ).rejects.toThrow(/orderField\.type must be one of/);
    });

    it('rejects orderField.key that is not lowercase snake_case', async () => {
        await expect(
            makeProduct({
                orderFields: [{ id: 'f1', label: 'X', key: 'PlayerID', type: 'text' }]
            })
        ).rejects.toThrow(/snake_case/);
    });

    it('accepts all supported field types', async () => {
        const typeFields = Object.values(FIELD_TYPES).map((t, i) => ({
            id: `f${i}`, label: `Field ${t}`, key: `field_${t}`, type: t,
        }));
        const p = await makeProduct({ orderFields: typeFields });
        expect(p.orderFields).toHaveLength(Object.values(FIELD_TYPES).length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] Order creation with orderFields
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] Order creation — orderFields integration', () => {
    let customer;

    beforeEach(async () => {
        ({ customer } = await createCustomerWithGroup(
            { walletBalance: 5000, creditLimit: 0 },
            { percentage: 0 }
        ));
    });

    it('product with no orderFields accepts order without orderFieldsValues', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10 });
        const { order } = await createOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        expect(order.customerInput).toBeNull();
    });

    it('product with required orderFields accepts valid orderFieldsValues', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { player_id: '9876', server: 'NA' },
        });
        expect(order.customerInput).not.toBeNull();
        expect(order.customerInput.values.player_id).toBe('9876');
        expect(order.customerInput.values.server).toBe('NA');
    });

    it('accepts customInputs object and remaps order-field labels to internal keys', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            customInputs: {
                'Player ID': 'player-555',
                Server: 'EU',
            },
        });

        expect(order.customerInput).not.toBeNull();
        expect(order.customerInput.values.player_id).toBe('player-555');
        expect(order.customerInput.values.server).toBe('EU');
        expect(order.customInputs.player_id).toBe('player-555');
    });

    it('accepts dynamicFields with customInputs array and stores sanitized values', async () => {
        const product = await createProduct({
            basePrice: 10,
            minQty: 1,
            maxQty: 10,
            dynamicFields: [
                { name: 'Player ID', label: 'Player ID', type: 'text', required: true },
                { name: 'Server', label: 'Server', type: 'select', required: true },
            ],
        });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            customInputs: [
                { label: 'Player ID', value: 'hero-123' },
                { name: 'Server', value: 'MENA' },
            ],
        });

        expect(order.customerInput).not.toBeNull();
        expect(order.customerInput.values['Player ID']).toBe('hero-123');
        expect(order.customerInput.values.Server).toBe('MENA');
        expect(order.customInputs['Player ID']).toBe('hero-123');
        expect(order.customInputs.Server).toBe('MENA');
    });

    it('rejects customInputs when a required dynamic field is missing', async () => {
        const product = await createProduct({
            basePrice: 10,
            minQty: 1,
            maxQty: 10,
            dynamicFields: [
                { name: 'Player ID', label: 'Player ID', type: 'text', required: true },
                { name: 'Server', label: 'Server', type: 'text', required: true },
            ],
        });

        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                customInputs: { 'Player ID': 'only-one-field' },
            })
        ).rejects.toMatchObject({ code: 'INVALID_ORDER_FIELDS' });
    });

    it('customerInput.values stores correctly coerced values', async () => {
        const numField = [{
            id: 'f1', label: 'Amount', key: 'amount', type: 'number',
            required: true, isActive: true,
        }];
        const product = await createProduct({ basePrice: 5, minQty: 1, maxQty: 10, orderFields: numField });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { amount: '100' },  // string → should be coerced to number
        });
        expect(order.customerInput.values.amount).toBe(100);
    });

    it('customerInput.fieldsSnapshot stores correct simplified shape', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { player_id: '123', server: 'EU' },
        });
        const snap = order.customerInput.fieldsSnapshot;
        // Only active fields appear in snapshot
        expect(snap.length).toBe(3);  // all 3 FIELDS are active
        expect(snap[0]).toMatchObject({ key: 'player_id', label: 'Player ID', type: 'text' });
        expect(snap[1]).toMatchObject({ key: 'server', label: 'Server', type: 'select' });
        // Select snapshot includes options
        expect(snap[1].options).toEqual(['EU', 'NA', 'Middle East']);
    });

    it('rejects order with INVALID_ORDER_FIELDS when required field is missing', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                orderFieldsValues: { server: 'EU' },  // player_id missing
            })
        ).rejects.toMatchObject({ code: 'INVALID_ORDER_FIELDS' });
    });

    it('rejects order with INVALID_ORDER_FIELDS for unknown field key', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                orderFieldsValues: { player_id: '123', server: 'EU', unknown_field: 'x' },
            })
        ).rejects.toMatchObject({ code: 'INVALID_ORDER_FIELDS' });
    });

    it('rejects order with INVALID_ORDER_FIELDS for invalid select value', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                orderFieldsValues: { player_id: '123', server: 'INVALID' },
            })
        ).rejects.toMatchObject({ code: 'INVALID_ORDER_FIELDS' });
    });

    it('customerInput is null when product has no orderFields', async () => {
        // createProduct from testHelpers creates a product with no custom orderFields
        const product = await createProduct();
        const { order } = await createOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        expect(order.customerInput).toBeNull();
    });

    it('wallet is NOT debited when orderFields validation fails', async () => {
        const { User } = require('../modules/users/user.model');
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });

        const before = await User.findById(customer._id);
        const balanceBefore = before.walletBalance;

        await expect(
            createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                orderFieldsValues: { server: 'EU' },  // required player_id missing
            })
        ).rejects.toMatchObject({ code: 'INVALID_ORDER_FIELDS' });

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(balanceBefore);  // unchanged
    });

    it('snapshot is immutable — admin changes to product.orderFields do not alter stored order', async () => {
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { player_id: '999', server: 'NA' },
        });

        // Admin removes all orderFields from the product
        await Product.findByIdAndUpdate(product._id, { orderFields: [] });

        // The stored order's snapshot is completely unchanged
        const reloaded = await Order.findById(order._id);
        expect(reloaded.customerInput.fieldsSnapshot).toHaveLength(3);
        expect(reloaded.customerInput.values.player_id).toBe('999');
    });

    it('optional field absent from submission: order accepted and key absent from values', async () => {
        // FIELDS[2] (gift_note) is optional — omitting it must succeed
        const product = await createProduct({ basePrice: 10, minQty: 1, maxQty: 10, orderFields: FIELDS });
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { player_id: '42', server: 'EU' },  // gift_note not supplied
        });
        expect(order.customerInput.values.gift_note).toBeUndefined();
        // The snapshot still lists gift_note (it was active at order time)
        const snapKeys = order.customerInput.fieldsSnapshot.map((f) => f.key);
        expect(snapKeys).toContain('gift_note');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] Admin product API — orderFields management
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] Admin product API — orderFields management', () => {
    it('createProduct persists orderFields via service', async () => {
        const product = await productService.createProduct({
            name: `Fields-Product-${Date.now()}`,
            basePrice: 9.99,
            minQty: 1,
            maxQty: 50,
            orderFields: FIELDS,
        });

        expect(product.orderFields).toHaveLength(3);
        expect(product.orderFields[0].key).toBe('player_id');
        expect(product.orderFields[0].required).toBe(true);
        expect(product.orderFields[1].options).toEqual(['EU', 'NA', 'Middle East']);
    });

    it('createProduct with no orderFields defaults to empty array', async () => {
        const product = await productService.createProduct({
            name: `Simple-Product-${Date.now()}`,
            basePrice: 5.00,
            minQty: 1,
            maxQty: 10,
        });

        expect(product.orderFields).toEqual([]);
    });

    it('updateProduct replaces orderFields', async () => {
        const product = await productService.createProduct({
            name: `Update-Test-${Date.now()}`,
            basePrice: 5.00,
            minQty: 1,
            maxQty: 10,
            orderFields: [FIELDS[0]],
        });

        const updated = await productService.updateProduct(product._id, {
            orderFields: [FIELDS[1]],  // replace: only Server field
        });

        expect(updated.orderFields).toHaveLength(1);
        expect(updated.orderFields[0].key).toBe('server');
    });

    it('updateProduct does not touch orderFields when not in payload', async () => {
        const product = await productService.createProduct({
            name: `Preserve-Test-${Date.now()}`,
            basePrice: 5.00,
            minQty: 1,
            maxQty: 10,
            orderFields: FIELDS,
        });

        // Update name only — orderFields should be unchanged
        const updated = await productService.updateProduct(product._id, {
            name: `Preserve-Test-Renamed-${Date.now()}`,
        });

        expect(updated.orderFields).toHaveLength(3);
    });

    it('updateProduct can clear all orderFields by passing empty array', async () => {
        const product = await productService.createProduct({
            name: `Clear-Test-${Date.now()}`,
            basePrice: 5.00,
            minQty: 1,
            maxQty: 10,
            orderFields: FIELDS,
        });

        const updated = await productService.updateProduct(product._id, {
            orderFields: [],
        });

        expect(updated.orderFields).toHaveLength(0);
    });
});
