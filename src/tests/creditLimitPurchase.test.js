'use strict';

const { debitWalletAtomic } = require('../modules/wallet/wallet.service');
const orderService = require('../modules/orders/order.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const { Order } = require('../modules/orders/order.model');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB, disconnectTestDB, clearCollections,
    createGroup, createCustomer, createProduct, createAdmin,
} = require('./testHelpers');

let group;
beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    group = await createGroup({ percentage: 0 });
});

describe('purchases within an approved credit limit', () => {
    it('restores the balance and credit usage once when a credit-funded order fails', async () => {
        const user = await createCustomer({ groupId: group._id, walletBalance: 0, creditLimit: 100, creditUsed: 0 });
        const product = await createProduct({ basePrice: 60 });
        const { order } = await orderService.createOrder({
            userId: user._id, productId: product._id, quantity: 1,
            idempotencyKey: `credit-refund:${user._id}`,
        });
        expect((await User.findById(user._id)).walletBalance).toBe(-60);
        await orderService.markOrderAsFailed(order._id);
        const stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(0);
        expect(stored.creditUsed).toBe(0);
        expect(stored.availableBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: 'REFUND' })).toBe(1);
    });

    it('lets the customer place successive real orders while the approved limit still covers them', async () => {
        const user = await createCustomer({ groupId: group._id, walletBalance: 0, creditLimit: 100, creditUsed: 0 });
        const firstProduct = await createProduct({ basePrice: 60 });
        const secondProduct = await createProduct({ basePrice: 40 });
        const first = await orderService.createOrder({ userId: user._id, productId: firstProduct._id, quantity: 1, idempotencyKey: `credit-order-first:${user._id}` });
        const second = await orderService.createOrder({ userId: user._id, productId: secondProduct._id, quantity: 1, idempotencyKey: `credit-order-second:${user._id}` });
        expect(first.order.status).toBe('PENDING');
        expect(second.order.status).toBe('PENDING');
        expect((await User.findById(user._id)).walletBalance).toBe(-100);
        expect(await Order.countDocuments({ userId: user._id })).toBe(2);
        await expect(orderService.createOrder({ userId: user._id, productId: secondProduct._id, quantity: 1, idempotencyKey: `credit-order-excess:${user._id}` }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(await Order.countDocuments({ userId: user._id })).toBe(2);
    });

    it('allows a second purchase against remaining credit and rejects the first amount beyond the limit', async () => {
        const user = await createCustomer({ groupId: group._id, walletBalance: 0, creditLimit: 100, creditUsed: 0 });
        await debitWalletAtomic({ userId: user._id, amount: 60, idempotencyKey: `credit-first:${user._id}` });
        let stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(-60);
        expect(stored.creditUsed).toBe(60);
        expect(stored.availableBalance).toBe(40);

        await debitWalletAtomic({ userId: user._id, amount: 40, idempotencyKey: `credit-second:${user._id}` });
        stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(-100);
        expect(stored.creditUsed).toBe(100);
        expect(stored.availableBalance).toBe(0);

        await expect(debitWalletAtomic({ userId: user._id, amount: 0.01, idempotencyKey: `credit-excess:${user._id}` }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect((await User.findById(user._id)).walletBalance).toBe(-100);
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: 'DEBIT' })).toBe(2);
    });

    it('counts creditUsed that is separate from the negative wallet balance only once', async () => {
        const user = await createCustomer({ groupId: group._id, walletBalance: -40, creditLimit: 100, creditUsed: 70 });
        expect((await User.findById(user._id)).availableBalance).toBe(30);
        await debitWalletAtomic({ userId: user._id, amount: 30, idempotencyKey: `legacy-within:${user._id}` });
        expect((await User.findById(user._id)).walletBalance).toBe(-70);
        await expect(debitWalletAtomic({ userId: user._id, amount: 0.01, idempotencyKey: `legacy-excess:${user._id}` }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: 'DEBIT' })).toBe(1);
    });

    it('does not grant credit to a customer with no approved limit', async () => {
        const user = await createCustomer({ groupId: group._id, walletBalance: 0, creditLimit: 0, creditUsed: 0 });
        await expect(debitWalletAtomic({ userId: user._id, amount: 1, idempotencyKey: `no-limit:${user._id}` }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });
});

describe('admin deductions against an approved credit limit', () => {
    it('deducts once, records the debit, and preserves the remaining credit for a customer purchase', async () => {
        const admin = await createAdmin();
        const user = await createCustomer({ groupId: group._id, walletBalance: -50, creditLimit: 100, creditUsed: 50 });
        const key = `admin-debit-credit:${user._id}`;

        await adminWalletService.deductFunds(user._id, 20, 'Test admin debit', admin._id, key);
        await adminWalletService.deductFunds(user._id, 20, 'Test admin debit', admin._id, key);
        let stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(-70);
        expect(stored.creditUsed).toBe(70);
        expect(stored.availableBalance).toBe(30);
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: 'DEBIT' })).toBe(1);

        const product = await createProduct({ basePrice: 30 });
        await orderService.createOrder({ userId: user._id, productId: product._id, quantity: 1, idempotencyKey: `after-admin-debit:${user._id}` });
        stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(-100);
        expect(stored.creditUsed).toBe(100);
        expect(stored.availableBalance).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: user._id, type: 'DEBIT' })).toBe(2);
    });

    it('refuses to deduct beyond the remaining credit without changing balance or creating a debit', async () => {
        const admin = await createAdmin();
        const user = await createCustomer({ groupId: group._id, walletBalance: -50, creditLimit: 100, creditUsed: 50 });
        await expect(adminWalletService.deductFunds(user._id, 50.01, 'Too much', admin._id, `admin-over-limit:${user._id}`))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        const stored = await User.findById(user._id);
        expect(stored.walletBalance).toBe(-50);
        expect(stored.creditUsed).toBe(50);
        expect(await WalletTransaction.countDocuments({ userId: user._id })).toBe(0);
    });
});
