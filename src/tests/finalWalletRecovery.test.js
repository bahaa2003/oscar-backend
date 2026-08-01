'use strict';

jest.mock('../modules/whatsapp/whatsapp.service', () => ({
    sendAdminNotification: jest.fn().mockResolvedValue(true),
}));

const mongoose = require('mongoose');
const orderService = require('../modules/orders/order.service');
const {
    debitWalletAtomic,
    refundWalletAtomic,
    creditWalletDirect,
    forcedDebitWallet,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('../modules/wallet/wallet.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
    freshUser,
    getTransactions,
} = require('./testHelpers');

let defaultGroup;

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    defaultGroup = await createGroup({ name: 'WalletRecoveryDefault', percentage: 0 });
});

const createWalletUser = (overrides = {}) => createCustomer({
    groupId: defaultGroup._id,
    ...overrides,
});

describe('Final wallet overdraft recovery', () => {
    it('derives creditUsed while debiting through the credit limit and rejects excess debit without mutation', async () => {
        const user = await createWalletUser({ walletBalance: 0, creditLimit: 1000, creditUsed: 0 });

        await debitWalletAtomic({ userId: user._id, amount: 600, description: 'first debit' });
        let fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-600);
        expect(fresh.creditUsed).toBe(600);

        await debitWalletAtomic({ userId: user._id, amount: 400, description: 'second debit' });
        fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-1000);
        expect(fresh.creditUsed).toBe(1000);
        const ledgerCountBeforeRejectedDebit = await WalletTransaction.countDocuments({ userId: user._id });

        await expect(
            debitWalletAtomic({ userId: user._id, amount: 1, description: 'over limit' })
        ).rejects.toThrow();

        fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-1000);
        expect(fresh.creditUsed).toBe(1000);
        await expect(WalletTransaction.countDocuments({ userId: user._id })).resolves.toBe(ledgerCountBeforeRejectedDebit);
    });

    it('direct credits repay negative balances before becoming positive balance', async () => {
        const user = await createWalletUser({ walletBalance: -1000, creditLimit: 1000, creditUsed: 1000 });

        await creditWalletDirect({
            userId: user._id,
            amount: 2000,
            description: 'deposit repayment',
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: new mongoose.Types.ObjectId(),
            operation: TRANSACTION_OPERATIONS.CREDIT,
            requireSourceIdentity: true,
        });

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(1000);
        expect(fresh.creditUsed).toBe(0);
    });

    it('partial direct credit against debt keeps creditUsed derived from the remaining negative balance', async () => {
        const user = await createWalletUser({ walletBalance: -600, creditLimit: 1000, creditUsed: 600 });

        await creditWalletDirect({
            userId: user._id,
            amount: 200,
            description: 'partial debt repayment',
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: new mongoose.Types.ObjectId(),
            operation: TRANSACTION_OPERATIONS.CREDIT,
            requireSourceIdentity: true,
        });

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-400);
        expect(fresh.creditUsed).toBe(400);
    });

    it('reports creditUsedAmount as the incremental debt portion inside walletDeducted', async () => {
        const user = await createWalletUser({ walletBalance: 200, creditLimit: 1000, creditUsed: 0 });

        const result = await debitWalletAtomic({ userId: user._id, amount: 500, description: 'mixed debit' });

        expect(result.walletDeducted).toBe(500);
        expect(result.creditUsedAmount).toBe(300);
        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-300);
        expect(fresh.creditUsed).toBe(300);
    });

    it('refunds walletDeducted once and never adds creditUsedAmount on top', async () => {
        const user = await createWalletUser({ walletBalance: 200, creditLimit: 1000, creditUsed: 0 });
        const debit = await debitWalletAtomic({ userId: user._id, amount: 500, description: 'debit before refund' });

        const refund = await refundWalletAtomic({
            userId: user._id,
            walletDeducted: debit.walletDeducted,
            creditUsedAmount: debit.creditUsedAmount,
            reference: new mongoose.Types.ObjectId(),
            description: 'refund exact charge',
        });

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(200);
        expect(fresh.creditUsed).toBe(0);
        expect(refund.transaction.amount).toBe(500);
    });

    it('refund does not depend on stale creditUsed after an intervening deposit', async () => {
        const user = await createWalletUser({ walletBalance: 0, creditLimit: 1000, creditUsed: 0 });
        const debit = await debitWalletAtomic({ userId: user._id, amount: 600, description: 'debit' });

        await creditWalletDirect({
            userId: user._id,
            amount: 200,
            description: 'intervening deposit',
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: new mongoose.Types.ObjectId(),
            operation: TRANSACTION_OPERATIONS.CREDIT,
            requireSourceIdentity: true,
        });

        await refundWalletAtomic({
            userId: user._id,
            walletDeducted: debit.walletDeducted,
            creditUsedAmount: debit.creditUsedAmount,
            reference: new mongoose.Types.ObjectId(),
            description: 'refund after deposit',
        });

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(200);
        expect(fresh.creditUsed).toBe(0);
    });

    it('forced debit recalculates creditUsed from the resulting balance', async () => {
        const user = await createWalletUser({ walletBalance: 100, creditLimit: 1000, creditUsed: 0 });

        await forcedDebitWallet({ userId: user._id, amount: 800, description: 'forced debit' });

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-700);
        expect(fresh.creditUsed).toBe(700);
    });

    it('direct credit preserves source identity and duplicate source/idempotency is blocked before balance mutation', async () => {
        const user = await createWalletUser({ walletBalance: 0, creditLimit: 1000, creditUsed: 0 });
        const sourceId = new mongoose.Types.ObjectId();

        await creditWalletDirect({
            userId: user._id,
            amount: 100,
            description: 'first source credit',
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: 'deposit-source-1',
            requireSourceIdentity: true,
        });

        let txns = await getTransactions(user._id);
        expect(txns).toHaveLength(1);
        expect(txns[0].sourceType).toBe(TRANSACTION_SOURCE_TYPES.DEPOSIT);
        expect(String(txns[0].sourceId)).toBe(String(sourceId));
        expect(txns[0].operation).toBe(TRANSACTION_OPERATIONS.CREDIT);

        await expect(creditWalletDirect({
            userId: user._id,
            amount: 100,
            description: 'duplicate source credit',
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: 'deposit-source-1',
            requireSourceIdentity: true,
        })).rejects.toThrow(/already been applied/i);

        const fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(100);
        txns = await getTransactions(user._id);
        expect(txns).toHaveLength(1);
    });

    it('concurrent refund attempts credit the wallet exactly once through the order guard', async () => {
        const user = await createWalletUser({ walletBalance: 200, creditLimit: 1000, creditUsed: 0 });
        const product = await createProduct({ basePrice: 500, executionType: 'manual' });
        const { order } = await orderService.createOrder({
            userId: user._id,
            productId: product._id,
            quantity: 1,
        });

        let fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(-300);
        expect(fresh.creditUsed).toBe(300);

        await Promise.allSettled([
            orderService.markOrderAsFailed(order._id),
            orderService.markOrderAsFailed(order._id),
        ]);

        fresh = await freshUser(user._id);
        expect(fresh.walletBalance).toBe(200);
        expect(fresh.creditUsed).toBe(0);
        const refundTransactions = await WalletTransaction.find({ userId: user._id, type: 'REFUND' });
        expect(refundTransactions).toHaveLength(1);
        expect(refundTransactions[0].amount).toBe(500);
    });
});
