'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const walletService = require('../modules/wallet/wallet.service');
const { ReferralCommission } = require('../modules/referrals/referralCommission.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS } = require('../modules/audit/audit.constants');
const { Currency } = require('../modules/currency/currency.model');
const { User, REFERRAL_SOURCE } = require('../modules/users/user.model');
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
    config.referralCommission.enabled = true;
    config.referralCommission.ratePercent = 5;
});

afterEach(() => {
    depositService.__setDepositApprovalTestHooks({});
    walletService.__setWalletTestHooks({});
    config.referralCommission.enabled = false;
    config.referralCommission.ratePercent = null;
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

const seedCurrency = () => Currency.updateOne(
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

const createReferralApprovalFixture = async ({ referredOverrides = {}, referrerOverrides = {} } = {}) => {
    await seedCurrency();
    const group = await createGroup({ name: `Default-${Date.now()}`, percentage: 25, isDefault: true });
    const referrer = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        currency: 'USD',
        ...referrerOverrides,
    });
    const customer = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        currency: 'EGP',
        referredBy: referrer._id,
        referredAt: new Date('2026-01-01T00:00:00.000Z'),
        referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        ...referredOverrides,
    });
    const admin = await createAdmin();
    const deposit = await depositService.createDepositRequest({
        userId: customer._id,
        ...makeDepositPayload(),
    });
    return { group, referrer, customer, admin, deposit };
};

const fetchEvaluation = (depositId) =>
    DepositRequest.findById(depositId).select('+referralCommissionEvaluation');

const countApprovalSideEffects = async () => Promise.all([
    AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED }),
    AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT }),
]);

describe('Phase 2C deposit referral commission transaction', () => {
    it('creates deposit approval, wallet credit, wallet ledger, commission, and evaluation in one transaction', async () => {
        const { referrer, customer, admin, deposit } = await createReferralApprovalFixture();

        const approved = await depositService.approveDeposit(deposit._id, admin._id);

        const [freshDeposit, freshCustomer, freshReferrer, ledger, commissions] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            User.findById(referrer._id),
            WalletTransaction.findOne({
                userId: customer._id,
                sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
                sourceId: deposit._id,
                operation: TRANSACTION_OPERATIONS.CREDIT,
            }),
            ReferralCommission.find({ depositId: deposit._id }),
        ]);

        expect(approved.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshCustomer.walletBalance).toBe(10);
        expect(freshReferrer.walletBalance).toBe(0);
        expect(ledger.amount).toBe(10);
        expect(commissions).toHaveLength(1);
        expect(commissions[0].walletTransactionId.toString()).toBe(ledger._id.toString());
        expect(commissions[0].referrerId.toString()).toBe(referrer._id.toString());
        expect(commissions[0].referredUserId.toString()).toBe(customer._id.toString());
        expect(commissions[0].sourceAmount).toBe('500.00');
        expect(commissions[0].sourceCurrency).toBe('EGP');
        expect(commissions[0].sourceExchangeRate).toBe('50');
        expect(commissions[0].sourceAmountUsd).toBe('10.00');
        expect(commissions[0].commissionRatePercent).toBe('5');
        expect(commissions[0].commissionAmountUsd).toBe('0.50');
        expect(freshDeposit.referralCommissionEvaluation).toMatchObject({
            version: 'v1',
            outcome: 'CREATED',
            reason: 'CREATED',
            ratePercent: '5',
            amountUsd: '0.50',
        });
        expect(freshDeposit.referralCommissionEvaluation.commissionId.toString())
            .toBe(commissions[0]._id.toString());
    });

    it('approves an ineligible deposit without a commission and stores a NOT_ELIGIBLE snapshot', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture({
            referredOverrides: { referredBy: null, referredAt: null, referralSource: null },
        });

        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshDeposit, freshCustomer, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshDeposit.referralCommissionEvaluation).toMatchObject({
            outcome: 'NOT_ELIGIBLE',
            reason: 'NO_REFERRER',
            commissionId: null,
        });
        expect(freshCustomer.walletBalance).toBe(10);
        expect(commissionCount).toBe(0);
    });

    it('rolls back deposit, wallet, ledger, commission, audit, and notification boundaries when commission insert fails', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();
        let notificationBoundaryCount = 0;
        let auditBoundaryCount = 0;

        depositService.__setDepositApprovalTestHooks({
            beforeReferralCommissionInsert: async () => {
                throw new Error('commission insert boom');
            },
            beforePostCommitAudit: async () => {
                auditBoundaryCount += 1;
            },
            beforeApprovalNotification: async () => {
                notificationBoundaryCount += 1;
            },
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toThrow('commission insert boom');

        const [freshDeposit, freshUser, ledgerCount, commissionCount, sideEffects] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
            countApprovalSideEffects(),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshDeposit.referralCommissionEvaluation).toBeNull();
        expect(freshUser.walletBalance).toBe(0);
        expect(ledgerCount).toBe(0);
        expect(commissionCount).toBe(0);
        expect(sideEffects).toEqual([0, 0]);
        expect(auditBoundaryCount).toBe(0);
        expect(notificationBoundaryCount).toBe(0);
    });

    it('rolls back all financial writes when the commission evaluation snapshot update fails', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();

        depositService.__setDepositApprovalTestHooks({
            beforeReferralCommissionEvaluationUpdate: async () => {
                throw new Error('snapshot update boom');
            },
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toThrow('snapshot update boom');

        const [freshDeposit, freshUser, ledgerCount, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshDeposit.referralCommissionEvaluation).toBeNull();
        expect(freshUser.walletBalance).toBe(0);
        expect(ledgerCount).toBe(0);
        expect(commissionCount).toBe(0);
    });

    it('treats a pre-existing commission on a pending deposit as reconciliation-required without crediting', async () => {
        const { referrer, customer, admin, deposit } = await createReferralApprovalFixture();
        await ReferralCommission.create({
            referrerId: referrer._id,
            referredUserId: customer._id,
            depositId: deposit._id,
            walletTransactionId: new mongoose.Types.ObjectId(),
            sourceAmount: '500.00',
            sourceCurrency: 'EGP',
            sourceExchangeRate: '50',
            sourceAmountUsd: '10.00',
            commissionRatePercent: '5',
            commissionAmountUsd: '0.50',
            availableAt: new Date('2026-01-02T00:00:00.000Z'),
            referredAt: customer.referredAt,
            idempotencyKey: `deposit:${deposit._id}:referral-commission:v1`,
        });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });

        const [freshDeposit, freshUser, ledgerCount, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(freshUser.walletBalance).toBe(0);
        expect(ledgerCount).toBe(0);
        expect(commissionCount).toBe(1);
    });

    it('repeated healthy approval does not re-evaluate policy or create another commission', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();

        await depositService.approveDeposit(deposit._id, admin._id);
        config.referralCommission.ratePercent = 25;
        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshDeposit, freshUser, ledgerCount, commissionCount, commission] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
            ReferralCommission.findOne({ depositId: deposit._id }),
        ]);

        expect(freshUser.walletBalance).toBe(10);
        expect(ledgerCount).toBe(1);
        expect(commissionCount).toBe(1);
        expect(commission.commissionRatePercent).toBe('5');
        expect(freshDeposit.referralCommissionEvaluation.ratePercent).toBe('5');
    });

    it('two concurrent approvals create one wallet credit, one ledger, one commission, and one evaluation', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();

        await Promise.all([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        const [freshDeposit, freshUser, ledgerCount, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(freshDeposit.referralCommissionEvaluation.outcome).toBe('CREATED');
        expect(freshUser.walletBalance).toBe(10);
        expect(ledgerCount).toBe(1);
        expect(commissionCount).toBe(1);
    });

    it('unknown commit verification recognizes a healthy persisted commission state', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();

        depositService.__setDepositApprovalTestHooks({
            afterCommitBeforeResult: async () => {
                const err = new Error('commit result unknown');
                err.errorLabels = ['UnknownTransactionCommitResult'];
                throw err;
            },
        });

        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshDeposit, freshUser, ledgerCount, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.referralCommissionEvaluation.outcome).toBe('CREATED');
        expect(freshUser.walletBalance).toBe(10);
        expect(ledgerCount).toBe(1);
        expect(commissionCount).toBe(1);
    });

    it('requires reconciliation when a CREATED evaluation is missing its commission', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();
        const walletLedger = await WalletTransaction.create({
            userId: customer._id,
            type: 'CREDIT',
            amount: 10,
            balanceBefore: 0,
            balanceAfter: 10,
            reference: deposit._id,
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: deposit._id,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: `deposit:${deposit._id}:credit`,
            description: 'legacy broken commission state',
        });
        await DepositRequest.updateOne(
            { _id: deposit._id },
            {
                $set: {
                    status: DEPOSIT_STATUS.APPROVED,
                    reviewedBy: admin._id,
                    reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
                    referralCommissionEvaluation: {
                        version: 'v1',
                        outcome: 'CREATED',
                        reason: 'CREATED',
                        commissionId: new mongoose.Types.ObjectId(),
                        referrerId: customer._id,
                        ratePercent: '5',
                        amountUsd: '0.50',
                        evaluatedAt: new Date('2026-01-02T00:00:00.000Z'),
                    },
                },
            }
        );
        expect(walletLedger).toBeTruthy();

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });
    });

    it('does not retroactively commission a legacy approved deposit without a Phase 2C evaluation', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();
        await WalletTransaction.create({
            userId: customer._id,
            type: 'CREDIT',
            amount: 10,
            balanceBefore: 0,
            balanceAfter: 10,
            reference: deposit._id,
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            sourceId: deposit._id,
            operation: TRANSACTION_OPERATIONS.CREDIT,
            idempotencyKey: `deposit:${deposit._id}:credit`,
            description: 'legacy healthy deposit credit',
        });
        await DepositRequest.updateOne(
            { _id: deposit._id },
            {
                $set: {
                    status: DEPOSIT_STATUS.APPROVED,
                    reviewedBy: admin._id,
                    reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
                },
            }
        );

        await depositService.approveDeposit(deposit._id, admin._id);

        const [freshDeposit, commissionCount] = await Promise.all([
            fetchEvaluation(deposit._id),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(freshDeposit.referralCommissionEvaluation).toBeNull();
        expect(commissionCount).toBe(0);
    });

    it('retry success creates one commission and invokes post-commit effects once', async () => {
        const { customer, admin, deposit } = await createReferralApprovalFixture();
        let attempt = 0;
        let auditBoundaryCount = 0;
        let notificationBoundaryCount = 0;

        depositService.__setDepositApprovalTestHooks({
            beforeDepositUpdate: async () => {
                attempt += 1;
                if (attempt === 1) {
                    const err = new Error('temporary commission transaction conflict');
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

        const [freshUser, ledgerCount, commissionCount] = await Promise.all([
            User.findById(customer._id),
            WalletTransaction.countDocuments({ userId: customer._id }),
            ReferralCommission.countDocuments({ depositId: deposit._id }),
        ]);

        expect(attempt).toBeGreaterThanOrEqual(2);
        expect(attempt).toBeLessThanOrEqual(depositService.MAX_DEPOSIT_TRANSACTION_ATTEMPTS);
        expect(freshUser.walletBalance).toBe(10);
        expect(ledgerCount).toBe(1);
        expect(commissionCount).toBe(1);
        expect(auditBoundaryCount).toBe(1);
        expect(notificationBoundaryCount).toBe(1);
    });
});
