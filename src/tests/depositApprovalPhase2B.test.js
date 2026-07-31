'use strict';

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const walletService = require('../modules/wallet/wallet.service');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS } = require('../modules/audit/audit.constants');
const { Currency } = require('../modules/currency/currency.model');
const { User } = require('../modules/users/user.model');
const {
    WalletTransaction,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    depositService.__setDepositApprovalTestHooks({});
    walletService.__setWalletTestHooks({});
});

afterEach(() => {
    depositService.__setDepositApprovalTestHooks({});
    walletService.__setWalletTestHooks({});
    jest.restoreAllMocks();
});

const makeDepositPayload = (overrides = {}) => ({
    paymentMethodId: 'bank-egp',
    requestedAmount: 500,
    currency: 'EGP',
    exchangeRate: 50,
    amountUsd: 10,
    receiptImage: 'uploads/deposits/receipt.jpg',
    ...overrides,
});

const createUserPair = async (customerOverrides = {}) => {
    await Currency.updateOne(
        { code: 'EGP' },
        {
            $setOnInsert: {
                code: 'EGP',
                name: 'Egyptian Pound',
                symbol: 'EGP',
                platformRate: 50,
                isActive: true,
            },
        },
        { upsert: true }
    );
    const group = await createGroup({ name: `Default-${Date.now()}`, percentage: 0 });
    const customer = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        currency: 'EGP',
        ...customerOverrides,
    });
    const admin = await createAdmin();
    return { customer, admin };
};

const createDeposit = (userId, overrides = {}) =>
    depositService.createDepositRequest({
        userId,
        ...makeDepositPayload(overrides),
    });

const createCreditLedger = (deposit, overrides = {}) => WalletTransaction.create({
    userId: deposit.userId,
    type: 'CREDIT',
    amount: 10,
    balanceBefore: 0,
    balanceAfter: 10,
    reference: deposit._id,
    status: 'COMPLETED',
    description: 'test deposit credit',
    ...overrides,
});

const flushSideEffects = () => new Promise((resolve) => setTimeout(resolve, 100));
const maxDepositTransactionAttempts = depositService.MAX_DEPOSIT_TRANSACTION_ATTEMPTS;

describe('Phase 2B atomic deposit approval', () => {
    it('rolls back deposit approval and wallet balance when ledger insertion fails', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        walletService.__setWalletTestHooks({
            beforeWalletLedgerInsert: async () => {
                throw new Error('ledger boom');
            },
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toThrow('ledger boom');

        const [freshDeposit, freshUser, txCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(0);
    });

    it('rolls back deposit status when an in-transaction failure occurs after the claim', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        depositService.__setDepositApprovalTestHooks({
            afterDepositUpdate: async () => {
                throw new Error('deposit claim failure');
            },
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toThrow('deposit claim failure');

        const [freshDeposit, freshUser, txCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(0);
    });

    it('succeeds after a transient transaction error without duplicating financial writes', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        let attempts = 0;

        depositService.__setDepositApprovalTestHooks({
            beforeDepositUpdate: async () => {
                attempts += 1;
                if (attempts === 1) {
                    const err = new Error('temporary write conflict');
                    err.errorLabels = ['TransientTransactionError'];
                    throw err;
                }
            },
        });

        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshUser, txCount] = await Promise.all([
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(attempts).toBeLessThanOrEqual(maxDepositTransactionAttempts);
        expect(freshUser.walletBalance).toBe(10);
        expect(txCount).toBe(1);
    });

    it('stops transient transaction retries at the configured maximum and rolls back all financial writes', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        let attempts = 0;
        let auditBoundaryCount = 0;
        let notificationBoundaryCount = 0;

        depositService.__setDepositApprovalTestHooks({
            beforeDepositUpdate: async () => {
                attempts += 1;
                const err = new Error('repeatable transient write conflict');
                err.errorLabels = ['TransientTransactionError'];
                throw err;
            },
            beforePostCommitAudit: async () => {
                auditBoundaryCount += 1;
            },
            beforeApprovalNotification: async () => {
                notificationBoundaryCount += 1;
            },
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_APPROVAL_RETRY_EXHAUSTED' });

        const [freshDeposit, freshUser, txCount, approveAuditCount, walletAuditCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED }),
            AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT }),
        ]);

        expect(attempts).toBe(maxDepositTransactionAttempts);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(0);
        expect(approveAuditCount).toBe(0);
        expect(walletAuditCount).toBe(0);
        expect(auditBoundaryCount).toBe(0);
        expect(notificationBoundaryCount).toBe(0);
    });

    it.each([
        ['invalid amount', async ({ deposit, admin }) => ({
            promise: depositService.approveDeposit(deposit._id, admin._id, { amount: 0 }),
            code: 'INVALID_APPROVED_AMOUNT',
            transactionAttempts: 1,
        })],
        ['inactive user', async ({ customer, deposit, admin }) => {
            await User.findByIdAndUpdate(customer._id, { status: 'PENDING' });
            return {
                promise: depositService.approveDeposit(deposit._id, admin._id),
                code: 'ACCOUNT_INACTIVE',
                transactionAttempts: 1,
            };
        }],
        ['invalid currency', async ({ deposit, admin }) => ({
            promise: depositService.approveDeposit(deposit._id, admin._id, { currency: 'XYZ' }),
            code: 'NOT_FOUND',
            transactionAttempts: 1,
        })],
        ['reconciliation-required state', async ({ deposit, admin }) => {
            await DepositRequest.findByIdAndUpdate(deposit._id, {
                status: DEPOSIT_STATUS.APPROVED,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
            });
            return {
                promise: depositService.approveDeposit(deposit._id, admin._id),
                code: 'DEPOSIT_RECONCILIATION_REQUIRED',
                transactionAttempts: 1,
            };
        }],
        ['unsupported transaction topology', async ({ deposit, admin }) => {
            const startSessionSpy = jest.spyOn(mongoose, 'startSession').mockImplementationOnce(() => {
                throw new Error('Transactions are not supported by this topology');
            });
            return {
                promise: depositService.approveDeposit(deposit._id, admin._id),
                code: 'FINANCIAL_TRANSACTION_UNAVAILABLE',
                transactionAttempts: 0,
                startSessionSpy,
            };
        }],
    ])('%s is not retried as a transient transaction', async (_name, setupScenario) => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        let transactionAttempts = 0;

        depositService.__setDepositApprovalTestHooks({
            transactionAttemptStarted: async () => {
                transactionAttempts += 1;
            },
        });

        const scenario = await setupScenario({ customer, deposit, admin });

        await expect(scenario.promise).rejects.toMatchObject({ code: scenario.code });
        expect(transactionAttempts).toBe(scenario.transactionAttempts);
        if (scenario.startSessionSpy) {
            expect(scenario.startSessionSpy).toHaveBeenCalledTimes(1);
        }

        const [freshDeposit, freshUser, txCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshDeposit.status).toBe(
            _name === 'reconciliation-required state' ? DEPOSIT_STATUS.APPROVED : DEPOSIT_STATUS.PENDING
        );
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(0);
    });

    it('runs approval audit and notification boundaries once after a successful retry', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        let attempts = 0;
        let auditBoundaryCount = 0;
        let notificationBoundaryCount = 0;

        depositService.__setDepositApprovalTestHooks({
            beforeDepositUpdate: async () => {
                attempts += 1;
                if (attempts === 1) {
                    const err = new Error('one transient write conflict');
                    err.errorLabels = ['TransientTransactionError'];
                    throw err;
                }
            },
            beforePostCommitAudit: async () => {
                auditBoundaryCount += 1;
            },
            beforeApprovalNotification: async () => {
                notificationBoundaryCount += 1;
            },
        });

        await depositService.approveDeposit(deposit._id, admin._id);
        await flushSideEffects();

        const [freshDeposit, freshUser, txCount, approveAuditCount, walletAuditCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED }),
            AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT }),
        ]);

        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(attempts).toBeLessThanOrEqual(maxDepositTransactionAttempts);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshUser.walletBalance).toBe(10);
        expect(txCount).toBe(1);
        expect(approveAuditCount).toBe(1);
        expect(walletAuditCount).toBe(1);
        expect(auditBoundaryCount).toBe(1);
        expect(notificationBoundaryCount).toBe(1);
    });

    it('classifies unknown commit result by reading persisted deposit and source ledger', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        depositService.__setDepositApprovalTestHooks({
            afterCommitBeforeResult: async () => {
                const err = new Error('commit result unknown');
                err.errorLabels = ['UnknownTransactionCommitResult'];
                throw err;
            },
        });

        const result = await depositService.approveDeposit(deposit._id, admin._id);
        const [freshUser, txCount] = await Promise.all([
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(result.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshUser.walletBalance).toBe(10);
        expect(txCount).toBe(1);
    });

    it('fails safely when MongoDB transactions are unavailable', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        jest.spyOn(mongoose, 'startSession').mockImplementationOnce(() => {
            throw new Error('Transactions are not supported by this topology');
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'FINANCIAL_TRANSACTION_UNAVAILABLE' });

        const [freshDeposit, freshUser, txCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(0);
    });

    it('enforces one wallet ledger per deposit source identity', async () => {
        const { customer } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await createCreditLedger(deposit, {
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: deposit._id,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: `deposit:${deposit._id}:credit`,
        });

        await expect(createCreditLedger(deposit, {
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: deposit._id,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: `deposit:${deposit._id}:credit-duplicate`,
        })).rejects.toMatchObject({ code: 11000 });
    });

    it('returns idempotent success for an approved deposit with one matching source ledger', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshUser, txCount] = await Promise.all([
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshUser.walletBalance).toBe(10);
        expect(txCount).toBe(1);
    });

    it('requires reconciliation for approved deposits without a ledger', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        await DepositRequest.findByIdAndUpdate(deposit._id, {
            status: DEPOSIT_STATUS.APPROVED,
            reviewedBy: admin._id,
            reviewedAt: new Date(),
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });

        await expect(WalletTransaction.countDocuments({ userId: customer._id })).resolves.toBe(0);
    });

    it('requires reconciliation for approved duplicate or amount-mismatched ledgers', async () => {
        const { customer, admin } = await createUserPair();
        const duplicateDeposit = await createDeposit(customer._id, { receiptImage: 'uploads/deposits/dup.jpg' });
        const mismatchDeposit = await createDeposit(customer._id, { receiptImage: 'uploads/deposits/mismatch.jpg' });
        await DepositRequest.updateMany(
            { _id: { $in: [duplicateDeposit._id, mismatchDeposit._id] } },
            { status: DEPOSIT_STATUS.APPROVED, reviewedBy: admin._id, reviewedAt: new Date() }
        );

        await createCreditLedger(duplicateDeposit);
        await createCreditLedger(duplicateDeposit, {
            amount: 10,
            balanceBefore: 10,
            balanceAfter: 20,
            description: 'duplicate legacy credit',
        });
        await createCreditLedger(mismatchDeposit, { amount: 7, balanceAfter: 7 });

        await expect(depositService.approveDeposit(duplicateDeposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });
        await expect(depositService.approveDeposit(mismatchDeposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });
    });

    it('requires reconciliation for pending deposits with existing credit ledgers', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        await createCreditLedger(deposit);

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });

        const [freshDeposit, freshUser, txCount] = await Promise.all([
            DepositRequest.findById(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(txCount).toBe(1);
    });
});
