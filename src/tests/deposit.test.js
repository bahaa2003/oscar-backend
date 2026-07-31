'use strict';

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositController = require('../modules/deposits/deposit.controller');
const depositService = require('../modules/deposits/deposit.service');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES } = require('../modules/audit/audit.constants');
const { Setting } = require('../modules/admin/setting.model');
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
    USER_STATUS,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    invalidateSettingsCache();
});

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));

const makeDepositPayload = (overrides = {}) => ({
    paymentMethodId: 'bank-egp',
    requestedAmount: 500,
    currency: 'EGP',
    exchangeRate: 50,
    amountUsd: 10,
    receiptImage: 'uploads/deposits/receipt.jpg',
    senderDetails: {
        methodType: 'bank',
        field: 'account',
        label: 'Sender account',
        value: '01012345678',
    },
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
    const group = await createGroup({ name: 'Default', percentage: 0 });
    const customer = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        currency: 'EGP',
        ...customerOverrides,
    });
    const admin = await createAdmin();
    return { group, customer, admin };
};

const createDeposit = (userId, overrides = {}) =>
    depositService.createDepositRequest({
        userId,
        ...makeDepositPayload(overrides),
    });

describe('[1] DepositRequest model validation', () => {
    it('creates a valid current-schema deposit request', async () => {
        const { customer } = await createUserPair();

        const doc = await DepositRequest.create({
            userId: customer._id,
            ...makeDepositPayload(),
        });

        expect(doc._id).toBeDefined();
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(doc.reviewedBy).toBeNull();
        expect(doc.reviewedAt).toBeNull();
        expect(doc.requestedAmount).toBe(500);
        expect(doc.amountUsd).toBe(10);
        expect(doc.receiptImage).toBe('uploads/deposits/receipt.jpg');
    });

    it('requires the canonical financial fields', async () => {
        const { customer } = await createUserPair();

        await expect(
            DepositRequest.create({ userId: customer._id })
        ).rejects.toThrow(/paymentMethodId is required/);
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ requestedAmount: undefined }) })
        ).rejects.toThrow(/requestedAmount is required/);
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ currency: undefined }) })
        ).rejects.toThrow(/currency is required/);
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ exchangeRate: undefined }) })
        ).rejects.toThrow(/exchangeRate is required/);
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ amountUsd: undefined }) })
        ).rejects.toThrow(/amountUsd is required/);
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ receiptImage: undefined }) })
        ).rejects.toThrow(/receiptImage is required/);
    });

    it('enforces positive requested amounts and valid status values', async () => {
        const { customer } = await createUserPair();

        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ requestedAmount: 0 }) })
        ).rejects.toThrow();
        await expect(
            DepositRequest.create({ userId: customer._id, ...makeDepositPayload({ status: 'INVALID_STATUS' }) })
        ).rejects.toThrow();
    });

    it('exposes status virtuals', async () => {
        const { customer } = await createUserPair();

        const approved = await DepositRequest.create({
            userId: customer._id,
            ...makeDepositPayload({ status: DEPOSIT_STATUS.APPROVED }),
        });
        const rejected = await DepositRequest.create({
            userId: customer._id,
            ...makeDepositPayload({ status: DEPOSIT_STATUS.REJECTED, receiptImage: 'uploads/deposits/rejected.jpg' }),
        });
        const pending = await DepositRequest.create({
            userId: customer._id,
            ...makeDepositPayload({ receiptImage: 'uploads/deposits/pending.jpg' }),
        });

        expect(approved.isApproved).toBe(true);
        expect(rejected.isRejected).toBe(true);
        expect(pending.isPending).toBe(true);
    });
});

describe('[2] createDepositRequest', () => {
    it('creates a pending request with rounded financial fields', async () => {
        const { customer } = await createUserPair();

        const deposit = await createDeposit(customer._id, {
            requestedAmount: 123.456,
            amountUsd: 2.469,
        });

        expect(deposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(deposit.userId.toString()).toBe(customer._id.toString());
        expect(deposit.requestedAmount).toBe(123.46);
        expect(deposit.amountUsd).toBe(2.47);
        expect(deposit.reviewedBy).toBeNull();
    });

    it('normalizes legacy sender detail fields into senderDetails', () => {
        const normalized = depositService.normalizeSenderDetails({
            transferredFromNumber: ' 01111111111 ',
        });

        expect(normalized.value).toBe('01111111111');
    });

    it('creates a DEPOSIT_REQUESTED audit log', async () => {
        const { customer } = await createUserPair();

        const deposit = await createDeposit(customer._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.metadata.requestedAmount).toBe(500);
        expect(log.metadata.amountUsd).toBe(10);
        expect(log.metadata.password).toBeUndefined();
        expect(log.metadata.token).toBeUndefined();
    });

    it('allows multiple pending requests for the same user', async () => {
        const { customer } = await createUserPair();

        await createDeposit(customer._id);
        await createDeposit(customer._id, {
            requestedAmount: 200,
            amountUsd: 4,
            receiptImage: 'uploads/deposits/second.jpg',
        });

        await expect(DepositRequest.countDocuments({ userId: customer._id })).resolves.toBe(2);
    });

    it('persists created deposits with current-schema fields', async () => {
        const { customer } = await createUserPair();

        const deposit = await createDeposit(customer._id);
        const found = await DepositRequest.findById(deposit._id);

        expect(found).not.toBeNull();
        expect(found.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(found.paymentMethodId).toBe('bank-egp');
        expect(found.requestedAmount).toBe(500);
        expect(found.receiptImage).toBe('uploads/deposits/receipt.jpg');
    });
});

describe('[3] approveDeposit', () => {
    it('approves a pending deposit and credits the wallet once', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);
        const tx = await WalletTransaction.findOne({ userId: customer._id, type: 'CREDIT' });

        expect(updated.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
        expect(user.walletBalance).toBe(10);
        expect(tx.amount).toBe(10);
        expect(tx.balanceBefore).toBe(0);
        expect(tx.balanceAfter).toBe(10);
        expect(tx.sourceType).toBe(TRANSACTION_SOURCE_TYPES.DEPOSIT);
        expect(tx.sourceId.toString()).toBe(deposit._id.toString());
        expect(tx.operation).toBe(TRANSACTION_OPERATIONS.CREDIT);
        expect(tx.idempotencyKey).toBe(`deposit:${deposit._id}:credit`);
    });

    it('supports admin amount override and refreshes exchangeRate/amountUsd snapshot', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id, {
            amount: 250,
            adminNotes: 'Verified smaller transfer',
        });

        const updated = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);

        expect(updated.requestedAmount).toBe(250);
        expect(updated.exchangeRate).toBe(50);
        expect(updated.amountUsd).toBe(5);
        expect(updated.adminNotes).toBe('Verified smaller transfer');
        expect(user.walletBalance).toBe(5);
    });

    it('supports admin currency override and credits the wallet in the USD snapshot amount', async () => {
        const { customer, admin } = await createUserPair({ currency: 'SAR' });
        await Currency.create({ code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', platformRate: 4, isActive: true });
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id, {
            amount: 500,
            currency: 'EGP',
        });

        const updated = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);

        expect(updated.currency).toBe('EGP');
        expect(updated.exchangeRate).toBe(50);
        expect(updated.amountUsd).toBe(10);
        expect(user.walletBalance).toBe(10);
    });

    it('accepts the legacy numeric override argument', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id, 300);

        const user = await User.findById(customer._id);
        expect(user.walletBalance).toBe(6);
    });

    it('creates DEPOSIT_APPROVED and WALLET_CREDIT audit logs', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id, { amount: 450 });
        await flushAudit();

        const approveLog = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        const walletLog = await AuditLog.findOne({ action: WALLET_ACTIONS.CREDIT }).lean();

        expect(approveLog).not.toBeNull();
        expect(approveLog.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(approveLog.metadata.finalAmount).toBe(450);
        expect(approveLog.metadata.originalRequestedAmount).toBe(500);
        expect(approveLog.metadata.amountUsd).toBe(9);
        expect(walletLog).not.toBeNull();
        expect(walletLog.entityType).toBe(ENTITY_TYPES.WALLET);
        expect(walletLog.entityId.toString()).toBe(customer._id.toString());
    });

    it('returns idempotent success for repeat approval without a second wallet credit', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.approveDeposit(deposit._id, admin._id);
        const repeated = await depositService.approveDeposit(deposit._id, admin._id);

        const user = await User.findById(customer._id);
        const txCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });
        expect(repeated.status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(user.walletBalance).toBe(10);
        expect(txCount).toBe(1);
    });

    it('rejects invalid override currency before status or wallet changes', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id, { currency: 'XYZ' })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        const freshDeposit = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(user.walletBalance).toBe(0);
    });

    it('rejects inactive users before status or wallet changes', async () => {
        const { customer, admin } = await createUserPair({ status: USER_STATUS.REJECTED });
        const deposit = await createDeposit(customer._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });

        const freshDeposit = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);
        expect(freshDeposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(user.walletBalance).toBe(0);
    });

    it('returns clear errors for rejected or missing deposits', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
        await expect(depositService.approveDeposit(new mongoose.Types.ObjectId(), admin._id))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does not create approval or wallet-credit audit logs when approval fails', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);
        await DepositRequest.findByIdAndUpdate(deposit._id, { status: DEPOSIT_STATUS.REJECTED });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
        await flushAudit();

        await expect(AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED })).resolves.toBe(0);
        await expect(AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT })).resolves.toBe(0);
    });
});

describe('[4] rejectDeposit', () => {
    it('rejects a pending deposit without touching wallet or transactions', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.rejectDeposit(deposit._id, admin._id, 'Receipt mismatch');

        const updated = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);
        const txCount = await WalletTransaction.countDocuments({ userId: customer._id });

        expect(updated.status).toBe(DEPOSIT_STATUS.REJECTED);
        expect(updated.adminNotes).toBe('Receipt mismatch');
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
        expect(user.walletBalance).toBe(0);
        expect(txCount).toBe(0);
    });

    it('creates a DEPOSIT_REJECTED audit log', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.actorId.toString()).toBe(admin._id.toString());
    });

    it('records the admin reviewer in DEPOSIT_REJECTED metadata', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log.metadata.reviewedBy).toBe(admin._id.toString());
    });

    it('rejects invalid status transitions and missing deposits', async () => {
        const { customer, admin } = await createUserPair();
        const rejected = await createDeposit(customer._id);
        const approved = await createDeposit(customer._id, {
            receiptImage: 'uploads/deposits/approved.jpg',
        });

        await depositService.rejectDeposit(rejected._id, admin._id);
        await depositService.approveDeposit(approved._id, admin._id);

        await expect(depositService.rejectDeposit(rejected._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
        await expect(depositService.rejectDeposit(approved._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
        await expect(depositService.rejectDeposit(new mongoose.Types.ObjectId(), admin._id))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('[5] Concurrency', () => {
    it('two concurrent approvals credit the wallet exactly once', async () => {
        const { customer, admin } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        const user = await User.findById(customer._id);
        const txCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });

        expect(fulfilled).toHaveLength(2);
        expect(rejected).toHaveLength(0);
        expect(user.walletBalance).toBe(10);
        expect(txCount).toBe(1);
    });
});

describe('[6] listDeposits / listMyDeposits / getDepositById', () => {
    it('lists, filters, paginates, and enforces customer ownership', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const customerA = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'EGP' });
        const customerB = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'EGP' });
        const admin = await createAdmin();

        const approved = await createDeposit(customerA._id);
        await depositService.approveDeposit(approved._id, admin._id);
        const pendingA1 = await createDeposit(customerA._id, {
            requestedAmount: 200,
            amountUsd: 4,
            receiptImage: 'uploads/deposits/a1.jpg',
        });
        await createDeposit(customerA._id, {
            requestedAmount: 300,
            amountUsd: 6,
            receiptImage: 'uploads/deposits/a2.jpg',
        });
        await createDeposit(customerB._id, {
            requestedAmount: 100,
            amountUsd: 2,
            receiptImage: 'uploads/deposits/b1.jpg',
        });

        const all = await depositService.listDeposits();
        const pending = await depositService.listDeposits({ status: DEPOSIT_STATUS.PENDING });
        const page1 = await depositService.listDeposits({ page: 1, limit: 2 });
        const mine = await depositService.listMyDeposits(customerA._id);
        const found = await depositService.getDepositById(pendingA1._id, customerA._id);

        expect(all.deposits).toHaveLength(4);
        expect(all.pagination.total).toBe(4);
        expect(pending.deposits).toHaveLength(3);
        expect(pending.deposits.every((deposit) => deposit.status === DEPOSIT_STATUS.PENDING)).toBe(true);
        expect(page1.deposits).toHaveLength(2);
        expect(page1.pagination.pages).toBe(2);
        expect(mine.deposits).toHaveLength(3);
        expect(found._id.toString()).toBe(pendingA1._id.toString());
        await expect(depositService.getDepositById(pendingA1._id, customerB._id))
            .rejects.toMatchObject({ statusCode: 403 });
        await expect(depositService.getDepositById(new mongoose.Types.ObjectId()))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('filters approved deposits and paginates later pages', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'EGP' });
        const admin = await createAdmin();

        const approved = await createDeposit(customer._id);
        await depositService.approveDeposit(approved._id, admin._id);
        await createDeposit(customer._id, { receiptImage: 'uploads/deposits/page-a.jpg' });
        await createDeposit(customer._id, { receiptImage: 'uploads/deposits/page-b.jpg' });
        await createDeposit(customer._id, { receiptImage: 'uploads/deposits/page-c.jpg' });

        const approvedOnly = await depositService.listDeposits({ status: DEPOSIT_STATUS.APPROVED });
        const page2 = await depositService.listDeposits({ page: 2, limit: 2 });

        expect(approvedOnly.deposits).toHaveLength(1);
        expect(approvedOnly.deposits[0]._id.toString()).toBe(approved._id.toString());
        expect(page2.deposits).toHaveLength(2);
        expect(page2.pagination.total).toBe(4);
    });

    it('returns a deposit without ownership restriction for admin-style lookups', async () => {
        const { customer } = await createUserPair();
        const deposit = await createDeposit(customer._id);

        const found = await depositService.getDepositById(deposit._id);

        expect(found._id.toString()).toBe(deposit._id.toString());
    });
});

describe('[7] createDeposit controller readiness', () => {
    const makeResponse = () => {
        const res = {};
        res.statusCode = null;
        res.body = null;
        res.status = jest.fn((code) => {
            res.statusCode = code;
            return res;
        });
        res.json = jest.fn((body) => {
            res.body = body;
            return res;
        });
        return res;
    };

    const invokeCreateDeposit = async ({ paymentGroups }) => {
        const { customer } = await createUserPair();
        await Currency.create({
            code: 'USD',
            name: 'US Dollar',
            symbol: '$',
            platformRate: 1,
            isActive: true,
        });
        await Setting.create({
            key: 'paymentGroups',
            value: paymentGroups,
        });

        const req = {
            user: customer,
            body: {
                requestedAmount: '25',
                currency: 'USD',
                paymentMethodId: 'bank-usd',
                notes: 'controller test',
                senderDetails: JSON.stringify({ value: 'sender-1' }),
            },
            file: { filename: 'receipt-controller.jpg' },
            receiptAnalysisValidated: true,
            auditContext: null,
        };
        const res = makeResponse();

        await new Promise((resolve, reject) => {
            res.json.mockImplementation((body) => {
                res.body = body;
                resolve();
                return res;
            });
            depositController.createDeposit(req, res, reject);
        });

        return res;
    };

    it('accepts an active configured payment method', async () => {
        const res = await invokeCreateDeposit({
            paymentGroups: [{
                id: 'bank',
                name: 'Bank',
                isActive: true,
                methods: [{ id: 'bank-usd', name: 'USD Bank', isActive: true }],
            }],
        });

        expect(res.statusCode).toBe(201);
        expect(res.body.data.paymentMethodId).toBe('bank-usd');
        await expect(DepositRequest.countDocuments()).resolves.toBe(1);
    });

    it('rejects inactive or unknown payment methods before persistence', async () => {
        await expect(invokeCreateDeposit({
            paymentGroups: [{
                id: 'bank',
                name: 'Bank',
                isActive: true,
                methods: [{ id: 'bank-usd', name: 'USD Bank', isActive: false }],
            }],
        })).rejects.toMatchObject({ code: 'INVALID_PAYMENT_METHOD' });

        await expect(DepositRequest.countDocuments()).resolves.toBe(0);
    });
});
