'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../app');
const config = require('../config/config');
const { User, ROLES, RESELLER_STATUS, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Order } = require('../modules/orders/order.model');
const { ReferralCommission } = require('../modules/referrals/referralCommission.model');
const orderService = require('../modules/orders/order.service');
const {
    RESELLER_PRICING_CALCULATION_VERSION,
    calculateFinalUnitPrice,
    resolveEffectivePricingContext,
    calculateOrderPricing,
} = require('../modules/pricing/commercialPricing.service');
const {
    RESELLER_PRICING_RECONCILIATION_CODES,
    classifyUserPricingState,
    classifyOrderPricingSnapshot,
} = require('../../scripts/resellerPricingReconciliationPreflight');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    createProduct,
    freshUser,
} = require('./testHelpers');

let server;
let baseURL;

const tokenFor = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

const api = async (method, path, { token, data, params } = {}) => axios({
    method,
    url: `${baseURL}${path}`,
    data,
    params,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
    proxy: false,
});

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Phase 3B pricing context and calculations', () => {
    test('preserves Group.percentage as markup formula for normal and approved reseller users', async () => {
        const defaultGroup = await createGroup({ name: 'Default', percentage: 10, isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller Tier', percentage: 2.5 });
        const normal = await createCustomer({ groupId: defaultGroup._id });
        const reseller = await createCustomer({
            groupId: resellerGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
        });

        expect(calculateFinalUnitPrice('100', 10)).toMatchObject({
            finalUnitPrice: '110',
            adjustmentAmount: '10',
        });
        expect(calculateFinalUnitPrice('0.1', 0.2).finalUnitPrice).toBe('0.1002');

        const normalContext = await resolveEffectivePricingContext(normal._id);
        const resellerContext = await resolveEffectivePricingContext(reseller._id);

        expect(normalContext.pricingType).toBe('GROUP');
        expect(normalContext.effectiveGroup.percentage).toBe('10');
        expect(resellerContext.pricingType).toBe('RESELLER');
        expect(resellerContext.effectiveGroup.percentage).toBe('2.5');
        expect(resellerContext.calculationVersion).toBe(RESELLER_PRICING_CALCULATION_VERSION);
    });

    test('suspended and pending resellers do not receive reseller pricing', async () => {
        const defaultGroup = await createGroup({ name: 'Default', percentage: 20, isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 1 });
        const suspended = await createCustomer({
            groupId: defaultGroup._id,
            resellerStatus: RESELLER_STATUS.SUSPENDED,
            resellerGroupId: resellerGroup._id,
        });
        const pending = await createCustomer({
            groupId: defaultGroup._id,
            resellerStatus: RESELLER_STATUS.PENDING,
            resellerGroupId: resellerGroup._id,
        });

        await expect(resolveEffectivePricingContext(suspended._id)).resolves.toMatchObject({
            pricingType: 'GROUP',
            effectiveGroup: { percentage: '20' },
        });
        await expect(resolveEffectivePricingContext(pending._id)).resolves.toMatchObject({
            pricingType: 'GROUP',
            effectiveGroup: { percentage: '20' },
        });
    });

    test('approved reseller malformed commercial state fails reconciliation', async () => {
        const defaultGroup = await createGroup({ isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 3 });
        const mismatch = await createCustomer({
            groupId: defaultGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
        });
        const missing = await createCustomer({
            groupId: defaultGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: null,
        });
        const inactiveGroup = await createGroup({ isActive: false });
        const inactive = await createCustomer({
            groupId: inactiveGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: inactiveGroup._id,
        });

        await expect(resolveEffectivePricingContext(mismatch._id)).rejects.toMatchObject({ code: 'PRICING_RECONCILIATION_REQUIRED' });
        await expect(resolveEffectivePricingContext(missing._id)).rejects.toMatchObject({ code: 'PRICING_RECONCILIATION_REQUIRED' });
        await expect(resolveEffectivePricingContext(inactive._id)).rejects.toMatchObject({ code: 'PRICING_RECONCILIATION_REQUIRED' });
    });

    test('inactive or deleted users cannot resolve pricing', async () => {
        const group = await createGroup({ isDefault: true });
        const inactive = await createCustomer({ groupId: group._id, status: USER_STATUS.REJECTED });
        const deleted = await createCustomer({ groupId: group._id, deletedAt: new Date() });

        await expect(resolveEffectivePricingContext(inactive._id)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
        await expect(resolveEffectivePricingContext(deleted._id)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    });
});

describe('Phase 3B catalog, quote, and admin preview APIs', () => {
    test('authenticated reseller catalog receives backend-resolved safe price metadata', async () => {
        const resellerGroup = await createGroup({ percentage: 5, isDefault: true });
        const reseller = await createCustomer({
            groupId: resellerGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
        });
        await createProduct({ basePrice: '100', minQty: 1, maxQty: 10 });

        const response = await api('get', '/products', { token: tokenFor(reseller) });
        expect(response.status).toBe(200);
        const item = response.data.data[0];
        expect(item.finalPrice).toBe('105');
        expect(item.pricing).toMatchObject({
            finalUnitPrice: '105',
            pricingType: 'RESELLER',
            calculationVersion: RESELLER_PRICING_CALCULATION_VERSION,
        });
        expect(item.costPrice).toBeUndefined();
        expect(item.providerPrice).toBeUndefined();
        expect(item.markupValue).toBeUndefined();
    });

    test('quote endpoint computes totals and rejects client pricing tampering', async () => {
        const group = await createGroup({ percentage: 10, isDefault: true });
        const user = await createCustomer({ groupId: group._id });
        const product = await createProduct({ basePrice: '10', minQty: 1, maxQty: 100 });
        const token = tokenFor(user);

        const quoted = await api('post', '/pricing/me/quote', {
            token,
            data: { items: [{ productId: product._id.toString(), quantity: 3 }], currency: 'USD' },
        });
        expect(quoted.status).toBe(200);
        expect(quoted.data.data.items[0]).toMatchObject({
            unitPrice: '11',
            lineTotalUsd: '33',
            currency: 'USD',
        });
        expect(typeof quoted.data.data.total).toBe('string');

        const tampered = await api('post', '/pricing/me/quote', {
            token,
            data: { items: [{ productId: product._id.toString(), quantity: 1, unitPrice: '0.01' }] },
        });
        expect(tampered.status).toBe(400);
    });

    test('admin preview is read-only and permission protected', async () => {
        const group = await createGroup({ percentage: 12, isDefault: true });
        const user = await createCustomer({ groupId: group._id });
        const product = await createProduct({ basePrice: '50' });
        const denied = await createAdmin({ groupId: group._id, role: ROLES.SUPERVISOR, permissions: [] });
        const permitted = await createAdmin({ groupId: group._id, role: ROLES.SUPERVISOR, permissions: ['MANAGE_USERS'] });

        const deniedResponse = await api('get', '/admin/reseller-pricing/preview', {
            token: tokenFor(denied),
            params: { userId: user._id.toString(), productId: product._id.toString() },
        });
        expect(deniedResponse.status).toBe(403);

        const response = await api('get', '/admin/reseller-pricing/preview', {
            token: tokenFor(permitted),
            params: { userId: user._id.toString(), productId: product._id.toString(), quantity: 2, currency: 'USD' },
        });
        expect(response.status).toBe(200);
        expect(response.data.data.preview).toMatchObject({
            baseUnitPrice: '50',
            percentage: '12',
            finalUnitPrice: '56',
            lineTotalUsd: '112',
        });
        expect(await Order.countDocuments()).toBe(0);
    });
});

describe('Phase 3B order creation snapshots and tampering protection', () => {
    test('approved reseller order stores immutable commercial and item pricing snapshots', async () => {
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 5, isDefault: true });
        const reseller = await createCustomer({
            groupId: resellerGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
            walletBalance: 1000,
        });
        const product = await createProduct({ basePrice: '100', minQty: 1, maxQty: 10 });

        const { order } = await orderService.createOrder({
            userId: reseller._id,
            productId: product._id,
            quantity: 2,
            idempotencyKey: 'phase-3b-snapshot',
        });

        expect(order.basePriceSnapshot).toBe('100');
        expect(order.markupPercentageSnapshot).toBe(5);
        expect(order.finalPriceCharged).toBe('105');
        expect(order.usdAmount).toBe('210');
        expect(order.pricingSnapshot.customerCommercialSnapshot).toMatchObject({
            resellerStatus: RESELLER_STATUS.APPROVED,
            effectiveGroupName: 'Reseller',
            groupPercentage: '5',
            pricingType: 'RESELLER',
        });
        expect(order.pricingSnapshot.items[0]).toMatchObject({
            baseUnitPrice: '100',
            adjustmentAmount: '5',
            finalUnitPrice: '105',
            quantity: 2,
            lineTotalUsd: '210',
        });
    });

    test('historical order snapshot remains unchanged after product, group, and reseller state change', async () => {
        const defaultGroup = await createGroup({ name: 'Default', percentage: 20, isDefault: true });
        const resellerGroup = await createGroup({ name: 'Reseller', percentage: 1 });
        const reseller = await createCustomer({
            groupId: resellerGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
            walletBalance: 1000,
        });
        const product = await createProduct({ basePrice: '40', minQty: 1, maxQty: 10 });
        const { order } = await orderService.createOrder({
            userId: reseller._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: 'immutable-order',
        });

        await ProductUpdate(product._id, { basePrice: '99' });
        resellerGroup.percentage = 9;
        await resellerGroup.save();
        await User.findByIdAndUpdate(reseller._id, {
            resellerStatus: RESELLER_STATUS.SUSPENDED,
            groupId: defaultGroup._id,
        });

        const fresh = await Order.findById(order._id).lean();
        expect(fresh.finalPriceCharged).toBe('40.4');
        expect(fresh.pricingSnapshot.items[0].finalUnitPrice).toBe('40.4');
        expect(fresh.pricingSnapshot.customerCommercialSnapshot.groupPercentage).toBe('1');
    });

    test('order endpoint rejects lower client total, group spoofing, percentage spoofing, and alternate userId', async () => {
        const group = await createGroup({ percentage: 0, isDefault: true });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1000 });
        const product = await createProduct({ basePrice: '10' });
        const token = tokenFor(user);

        const response = await api('post', '/orders', {
            token,
            data: {
                productId: product._id.toString(),
                quantity: 1,
                unitPrice: '0.01',
                total: '0.01',
                groupId: new mongoose.Types.ObjectId().toString(),
                percentage: 0,
                resellerStatus: RESELLER_STATUS.APPROVED,
                exchangeRate: 1,
                userId: new mongoose.Types.ObjectId().toString(),
            },
        });

        expect(response.status).toBe(400);
        expect(await Order.countDocuments()).toBe(0);
        expect((await freshUser(user._id)).walletBalance).toBe(1000);
    });

    test('duplicate order submission preserves existing idempotency behavior and does not create duplicate orders', async () => {
        const group = await createGroup({ percentage: 0, isDefault: true });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1000 });
        const product = await createProduct({ basePrice: '10' });

        const first = await orderService.createOrder({
            userId: user._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: 'dup-phase-3b',
        });
        const second = await orderService.createOrder({
            userId: user._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: 'dup-phase-3b',
        });

        expect(String(second.order._id)).toBe(String(first.order._id));
        expect(second.idempotent).toBe(true);
        expect(await Order.countDocuments({ userId: user._id })).toBe(1);
    });
});

describe('Phase 3B preflight and referral finance non-regression', () => {
    test('preflight classifiers identify healthy and broken reseller pricing states', async () => {
        const defaultGroup = await createGroup({ isDefault: true });
        const resellerGroup = await createGroup({ percentage: 4 });
        const healthy = await createCustomer({
            groupId: resellerGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
        });
        const mismatch = await createCustomer({
            groupId: defaultGroup._id,
            resellerStatus: RESELLER_STATUS.APPROVED,
            resellerGroupId: resellerGroup._id,
        });

        await expect(classifyUserPricingState(healthy, defaultGroup)).resolves.toBe(RESELLER_PRICING_RECONCILIATION_CODES.HEALTHY_APPROVED_RESELLER);
        await expect(classifyUserPricingState(mismatch, defaultGroup)).resolves.toBe(RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_GROUP_MISMATCH);

        const order = await Order.create({
            userId: healthy._id,
            productId: (await createProduct())._id,
            orderNumber: 'PH3BPRE1',
            quantity: 1,
            unitPrice: '10',
            totalPrice: '10',
            basePriceSnapshot: '10',
            markupPercentageSnapshot: 0,
            finalPriceCharged: '10',
            groupIdSnapshot: resellerGroup._id,
            walletDeducted: 10,
            creditUsedAmount: '0',
        });
        expect(classifyOrderPricingSnapshot(order)).toBe(RESELLER_PRICING_RECONCILIATION_CODES.ORDER_MISSING_PRICING_SNAPSHOT);
    });

    test('Phase 3B does not mutate referral commissions, payouts, or use Group percentage as commission rate', async () => {
        const group = await createGroup({ percentage: 30, isDefault: true });
        const user = await createCustomer({ groupId: group._id, walletBalance: 1000 });
        const product = await createProduct({ basePrice: '10' });

        const quote = await calculateOrderPricing({
            userId: user._id,
            items: [{ productId: product._id, quantity: 1 }],
            currency: 'USD',
            rejectClientPricing: false,
        });

        expect(quote.items[0].unitPrice).toBeUndefined();
        expect(quote.items[0].finalUnitPrice).toBe('13');
        expect(await ReferralCommission.countDocuments()).toBe(0);
        const fresh = await freshUser(user._id);
        expect(fresh.referralBalance).toBeUndefined();
        expect(fresh.totalEarnings).toBeUndefined();
    });
});

const ProductUpdate = (productId, updates) => (
    require('../modules/products/product.model').Product.findByIdAndUpdate(productId, updates, { new: true })
);
