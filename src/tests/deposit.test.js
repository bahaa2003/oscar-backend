'use strict';

/**
 * deposit.test.js — Deposit Request System Test Suite
 * ─────────────────────────────────────────────────────
 *
 * [1] Model Validation
 *   - Required fields enforced
 *   - Status enum validated
 *   - requestedAmount > 0
 *   - Virtuals: isApproved, isRejected, isPending
 *
 * [2] createDepositRequest
 *   - Creates PENDING deposit
 *   - Creates DEPOSIT_REQUESTED audit log
 *   - Returns correct fields
 *
 * [3] approveDeposit
 *   - PENDING → APPROVED success
 *   - Wallet gets credited (walletBalance increases)
 *   - WalletTransaction record created
 *   - DEPOSIT_APPROVED + WALLET_CREDIT audit logs created
 *   - overrideAmount is used when provided
 *   - Cannot approve an already APPROVED deposit (DEPOSIT_ALREADY_APPROVED)
 *   - Cannot approve a REJECTED deposit (DEPOSIT_ALREADY_REJECTED)
 *
 * [4] rejectDeposit
 *   - PENDING → REJECTED success
 *   - Wallet is NOT credited
 *   - DEPOSIT_REJECTED audit log created
 *   - Cannot reject an already REJECTED deposit
 *   - Cannot reject an already APPROVED deposit
 *
 * [5] Concurrency
 *   - Two concurrent approve calls: only first succeeds
 *   - Wallet credited exactly once
 *
 * [6] listDeposits / listMyDeposits
 *   - Admin sees all deposits
 *   - Status filter works
 *   - Pagination works
 *
 * [7] getDepositById
 *   - Returns correct deposit
 *   - Throws NotFoundError for unknown ID
 *   - Customer ownership guard works
 *
 * [8] Audit correctness
 *   - Metadata does NOT contain sensitive tokens
 *   - Correct entityType, entityId, action on each event
 */

const mongoose = require('mongoose');
const path = require('path');
const { fork } = require('child_process');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES } = require('../modules/audit/audit.constants');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { DepositCreditGuard } = require('../modules/deposits/depositCreditGuard.model');
const { Currency } = require('../modules/currency/currency.model');
const adminUsersService = require('../modules/admin/admin.users.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const walletService = require('../modules/wallet/wallet.service');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    USER_STATUS,
} = require('./testHelpers');

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const flushAudit = () => new Promise((r) => setTimeout(r, 100));
const runApprovalWorker = (depositId) => new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'fixtures', 'depositApprovalWorker.js'), [depositId.toString()], {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    child.on('message', (message) => { result = message; });
    child.on('error', reject);
    child.on('exit', (code) => {
        if (code === 0 && result?.ok) resolve(result);
        else reject(new Error(result?.message || `approval worker exited with code ${code}`));
    });
});

const VALID_DEPOSIT = {
    paymentMethodId: 'bank-transfer',
    requestedAmount: 500,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 500,
    receiptImage: 'uploads/deposits/receipt.jpg',
    senderDetails: { methodType: 'bank-transfer', field: 'account', label: 'Account', value: '01012345678' },
};

let _group;
const ensureGroup = async () => {
    if (!_group) _group = await createGroup({ name: 'Default', percentage: 0 });
    return _group;
};
beforeEach(() => { _group = null; });

// ─────────────────────────────────────────────────────────────────────────────
// [1] MODEL VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] Model validation', () => {
    let userId;

    beforeEach(async () => {
        const group = await ensureGroup();
        const customer = await createCustomer({ groupId: group._id });
        userId = customer._id;
    });

    it('creates a valid deposit request with all required fields', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc._id).toBeDefined();
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(doc.reviewedBy).toBeNull();
        expect(doc.reviewedAt).toBeNull();
    });

    it('rejects when userId is missing', async () => {
        await expect(
            DepositRequest.create({ ...VALID_DEPOSIT })
        ).rejects.toThrow(/userId is required/);
    });

    it('rejects when requestedAmount is missing', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, requestedAmount: undefined })
        ).rejects.toThrow(/requestedAmount is required/);
    });

    it('rejects when requestedAmount <= 0', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, requestedAmount: 0 })
        ).rejects.toThrow(/greater than 0/);
    });

    it('rejects when receiptImage is missing', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, receiptImage: undefined })
        ).rejects.toThrow(/receiptImage is required/);
    });

    it('rejects when paymentMethodId is missing', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, paymentMethodId: undefined })
        ).rejects.toThrow(/paymentMethodId is required/);
    });

    it('rejects invalid status value', async () => {
        await expect(
            DepositRequest.create({ userId, ...VALID_DEPOSIT, status: 'INVALID_STATUS' })
        ).rejects.toThrow();
    });

    it('virtual isApproved returns true for APPROVED status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT, status: DEPOSIT_STATUS.APPROVED });
        expect(doc.isApproved).toBe(true);
        expect(doc.isRejected).toBe(false);
        expect(doc.isPending).toBe(false);
    });

    it('virtual isRejected returns true for REJECTED status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT, status: DEPOSIT_STATUS.REJECTED });
        expect(doc.isRejected).toBe(true);
        expect(doc.isApproved).toBe(false);
        expect(doc.isPending).toBe(false);
    });

    it('virtual isPending returns true for PENDING status', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc.isPending).toBe(true);
        expect(doc.isApproved).toBe(false);
        expect(doc.isRejected).toBe(false);
    });

    it('default status is PENDING', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] createDepositRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] createDepositRequest', () => {
    let customer;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id });
    });

    it('creates a PENDING deposit request with correct fields', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        expect(deposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(deposit.userId.toString()).toBe(customer._id.toString());
        expect(deposit.requestedAmount).toBe(500);
        expect(deposit.reviewedBy).toBeNull();
    });

    it('persists to the database', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        const found = await DepositRequest.findById(deposit._id);
        expect(found).not.toBeNull();
        expect(found.status).toBe(DEPOSIT_STATUS.PENDING);
    });

    it('creates DEPOSIT_REQUESTED audit log (fire-and-forget)', async () => {
        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });

        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.metadata.requestedAmount).toBe(500);
    });

    it('allows a user to submit multiple pending requests', async () => {
        await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT, requestedAmount: 200, amountUsd: 200 });

        const count = await DepositRequest.countDocuments({ userId: customer._id });
        expect(count).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] approveDeposit
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] approveDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('transitions status PENDING → APPROVED', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.APPROVED);
    });

    it('stores approved amount, reviewer, and review time on approval', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.requestedAmount).toBe(500);
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('credits the user wallet by requestedAmount', async () => {
        const before = await User.findById(customer._id);
        expect(before.walletBalance).toBe(0);

        await depositService.approveDeposit(deposit._id, admin._id);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(500);
    });

    it('creates a WalletTransaction CREDIT record', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const tx = await WalletTransaction.findOne({ userId: customer._id, type: 'CREDIT' });
        expect(tx).not.toBeNull();
        expect(tx.amount).toBe(500);
        expect(tx.balanceBefore).toBe(0);
        expect(tx.balanceAfter).toBe(500);
    });

    it('uses an admin amount override when provided', async () => {
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 300 });

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.requestedAmount).toBe(300);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(300);
    });

    it('creates DEPOSIT_APPROVED and WALLET_CREDIT audit logs', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        await flushAudit();

        const approveLog = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(approveLog).not.toBeNull();
        expect(approveLog.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(approveLog.metadata.finalAmount).toBe(500);

        const walletLog = await AuditLog.findOne({ action: WALLET_ACTIONS.CREDIT }).lean();
        expect(walletLog).not.toBeNull();
        expect(walletLog.entityType).toBe(ENTITY_TYPES.WALLET);
        expect(walletLog.entityId.toString()).toBe(customer._id.toString());
    });

    it('throws DEPOSIT_ALREADY_APPROVED when approving a second time', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws DEPOSIT_ALREADY_REJECTED when approving a rejected deposit', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(
            depositService.approveDeposit(fakeId, admin._id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('wallet is not credited again when duplicate approval is rejected', async () => {
        // First approval succeeds
        await depositService.approveDeposit(deposit._id, admin._id);
        const balanceAfterFirst = (await User.findById(customer._id)).walletBalance;

        // Second approval throws — wallet must not change
        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toBeDefined();

        const balanceAfterSecond = (await User.findById(customer._id)).walletBalance;
        expect(balanceAfterSecond).toBe(balanceAfterFirst);
    });

    it('uses the transfer-time USD snapshot when the currency rate changes before approval', async () => {
        await Currency.create({
            code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', platformRate: 10, isActive: true,
        });
        const frozenRequest = await depositService.createDepositRequest({
            userId: customer._id,
            paymentMethodId: 'bank-transfer',
            requestedAmount: 500,
            currency: 'SAR',
            exchangeRate: 4,
            amountUsd: 125,
            receiptImage: 'uploads/deposits/frozen-rate.jpg',
        });

        await depositService.approveDeposit(frozenRequest._id, admin._id);

        const updatedCustomer = await User.findById(customer._id);
        expect(updatedCustomer.walletBalance).toBe(125);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] rejectDeposit
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] rejectDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('transitions status PENDING → REJECTED', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.REJECTED);
    });

    it('sets reviewedBy and reviewedAt on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('does NOT credit the wallet on rejection', async () => {
        const before = (await User.findById(customer._id)).walletBalance;
        await depositService.rejectDeposit(deposit._id, admin._id);
        const after = (await User.findById(customer._id)).walletBalance;

        expect(after).toBe(before);
    });

    it('does NOT create a WalletTransaction on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        const count = await WalletTransaction.countDocuments({ userId: customer._id });
        expect(count).toBe(0);
    });

    it('creates DEPOSIT_REJECTED audit log', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.actorId.toString()).toBe(admin._id.toString());
    });

    it('throws DEPOSIT_ALREADY_REJECTED when rejecting a second time', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(
            depositService.rejectDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws DEPOSIT_ALREADY_APPROVED when rejecting an approved deposit', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(
            depositService.rejectDeposit(deposit._id, admin._id)
        ).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(
            depositService.rejectDeposit(new mongoose.Types.ObjectId(), admin._id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] CONCURRENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Concurrency', () => {
    it('two concurrent approve calls: only one succeeds, wallet credited once', async () => {
        const group = await ensureGroup();
        const customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const admin = await createAdmin();

        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,  // requestedAmount: 500
        });

        // Fire two approvals simultaneously
        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Exactly one succeeds
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('DEPOSIT_ALREADY_APPROVED');

        // Wallet credited exactly once
        const user = await User.findById(customer._id);
        expect(user.walletBalance).toBe(500);

        // Only one CREDIT transaction
        const txCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });
        expect(txCount).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [6] LIST QUERIES
// ─────────────────────────────────────────────────────────────────────────────

describe('[6] listDeposits / listMyDeposits', () => {
    let customerA;
    let customerB;
    let admin;

    beforeEach(async () => {
        const group = await ensureGroup();
        customerA = await createCustomer({ groupId: group._id });
        customerB = await createCustomer({ groupId: group._id });
        admin = await createAdmin();

        // 3 deposits for customerA (2 pending, 1 approved)
        const d1 = await depositService.createDepositRequest({ userId: customerA._id, ...VALID_DEPOSIT });
        await depositService.approveDeposit(d1._id, admin._id);
        await depositService.createDepositRequest({ userId: customerA._id, ...VALID_DEPOSIT, requestedAmount: 200 });
        await depositService.createDepositRequest({ userId: customerA._id, ...VALID_DEPOSIT, requestedAmount: 300 });

        // 1 deposit for customerB
        await depositService.createDepositRequest({ userId: customerB._id, ...VALID_DEPOSIT, requestedAmount: 100 });
    });

    it('listDeposits returns all deposits for admin', async () => {
        const result = await depositService.listDeposits();
        expect(result.deposits.length).toBe(4);
        expect(result.pagination.total).toBe(4);
    });

    it('listDeposits filters by status=PENDING', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.PENDING });
        expect(result.deposits.every(d => d.status === DEPOSIT_STATUS.PENDING)).toBe(true);
        expect(result.deposits.length).toBe(3);
    });

    it('listDeposits filters by status=APPROVED', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.APPROVED });
        expect(result.deposits.every(d => d.status === DEPOSIT_STATUS.APPROVED)).toBe(true);
        expect(result.deposits.length).toBe(1);
    });

    it('listMyDeposits returns only the requesting user deposits', async () => {
        const result = await depositService.listMyDeposits(customerA._id);
        expect(result.deposits.length).toBe(3);
        result.deposits.forEach(d => expect(d.userId.toString()).toBe(customerA._id.toString()));
    });

    it('listDeposits paginates correctly', async () => {
        const page1 = await depositService.listDeposits({ page: 1, limit: 2 });
        const page2 = await depositService.listDeposits({ page: 2, limit: 2 });

        expect(page1.deposits).toHaveLength(2);
        expect(page2.deposits).toHaveLength(2);
        expect(page1.pagination.total).toBe(4);
        expect(page1.pagination.pages).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [7] getDepositById
// ─────────────────────────────────────────────────────────────────────────────

describe('[7] getDepositById', () => {
    let customer;
    let otherCustomer;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id });
        otherCustomer = await createCustomer({ groupId: group._id });

        deposit = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
        });
    });

    it('returns the correct deposit when called without userId restriction', async () => {
        const found = await depositService.getDepositById(deposit._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('returns the deposit when requestingUserId matches', async () => {
        const found = await depositService.getDepositById(deposit._id, customer._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('throws AuthorizationError when requestingUserId does not match', async () => {
        await expect(
            depositService.getDepositById(deposit._id, otherCustomer._id)
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(
            depositService.getDepositById(new mongoose.Types.ObjectId())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [8] AUDIT CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────

describe('[8] Audit log correctness', () => {
    let customer;
    let admin;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();
    });

    it('DEPOSIT_REQUESTED log does not contain sensitive token fields', async () => {
        await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.metadata.password).toBeUndefined();
        expect(log.metadata.token).toBeUndefined();
        expect(log.metadata.accessToken).toBeUndefined();
    });

    it('DEPOSIT_REQUESTED log entityId matches the deposit _id', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
    });

    it('DEPOSIT_APPROVED log records the final approved amount in metadata', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 450 });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(log.metadata.finalAmount).toBe(450);
        expect(log.metadata.originalRequestedAmount).toBe(500);
    });

    it('DEPOSIT_REJECTED log records the admin reviewer', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log.actorId.toString()).toBe(admin._id.toString());
        expect(log.metadata.reviewedBy.toString()).toBe(admin._id.toString());
    });

    it('no DEPOSIT_APPROVED or WALLET_CREDIT logs when approval fails', async () => {
        const deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });

        // Manually REJECT the deposit so approval will throw
        await DepositRequest.findByIdAndUpdate(deposit._id, { status: DEPOSIT_STATUS.REJECTED });

        await expect(
            depositService.approveDeposit(deposit._id, admin._id)
        ).rejects.toBeDefined();

        await flushAudit();

        const approveCount = await AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED });
        const creditCount = await AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT });

        expect(approveCount).toBe(0);
        expect(creditCount).toBe(0);
    });
});

describe('[9] Deposit financial safety and recovery', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        const group = await ensureGroup();
        customer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        admin = await createAdmin();
        deposit = await depositService.createDepositRequest({ userId: customer._id, ...VALID_DEPOSIT });
    });

    it('credits once and records one idempotent ledger entry on normal approval', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const user = await User.findById(customer._id);
        const ledger = await WalletTransaction.find({ reference: deposit._id, type: 'CREDIT' });
        expect(user.walletBalance).toBe(500);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].idempotencyKey).toBe(`deposit:${deposit._id}:credit`);
        const indexes = await DepositCreditGuard.collection.indexes();
        expect(indexes.some((index) => index.unique && index.key?.idempotencyKey === 1)).toBe(true);
        expect(indexes.some((index) => index.unique && index.key?.depositId === 1)).toBe(true);
    });

    it('does not credit again when an approval request is repeated', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        await expect(depositService.approveDeposit(deposit._id, admin._id)).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('allows only one of two simultaneous approvals to credit the wallet', async () => {
        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('serializes two different deposits for the same wallet without losing either credit', async () => {
        const second = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 125,
            amountUsd: 125,
        });
        const results = await Promise.all([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(second._id, admin._id),
        ]);

        expect(results).toHaveLength(2);
        expect((await User.findById(customer._id)).walletBalance).toBe(625);
        expect(await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' })).toBe(2);
    });

    it('allows exactly one of concurrent approval and rejection to win', async () => {
        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.rejectDeposit(deposit._id, admin._id),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

        const finalDeposit = await DepositRequest.findById(deposit._id);
        const user = await User.findById(customer._id);
        const credits = await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' });
        if (finalDeposit.status === DEPOSIT_STATUS.APPROVED) {
            expect(user.walletBalance).toBe(500);
            expect(credits).toBe(1);
        } else {
            expect(finalDeposit.status).toBe(DEPOSIT_STATUS.REJECTED);
            expect(user.walletBalance).toBe(0);
            expect(credits).toBe(0);
        }
    });

    it('rolls back approval if the wallet update fails, then succeeds on retry', async () => {
        const updateSpy = jest.spyOn(User, 'findOneAndUpdate').mockRejectedValueOnce(new Error('injected wallet write failure'));
        await expect(depositService.approveDeposit(deposit._id, admin._id)).rejects.toThrow('injected wallet write failure');
        updateSpy.mockRestore();

        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.PENDING);
        expect((await User.findById(customer._id)).walletBalance).toBe(0);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(0);
        await depositService.approveDeposit(deposit._id, admin._id);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
    });

    it('resumes after a ledger write interruption without applying the wallet increment twice', async () => {
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        const ledgerSpy = jest.spyOn(WalletTransaction, 'findOneAndUpdate').mockRejectedValueOnce(new Error('injected ledger write failure'));
        await expect(depositService.resumeDepositApproval(deposit._id)).rejects.toThrow('injected ledger write failure');
        ledgerSpy.mockRestore();

        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        await depositService.resumeDepositApproval(deposit._id);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('resumes after the transaction row exists but guard completion fails', async () => {
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        const originalUpdateOne = DepositCreditGuard.updateOne.bind(DepositCreditGuard);
        const guardSpy = jest.spyOn(DepositCreditGuard, 'updateOne')
            .mockImplementationOnce((...args) => originalUpdateOne(...args))
            .mockRejectedValueOnce(new Error('injected guard completion failure'));
        await expect(depositService.resumeDepositApproval(deposit._id))
            .rejects.toThrow('injected guard completion failure');
        guardSpy.mockRestore();

        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
        await depositService.resumeDepositApproval(deposit._id);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect((await DepositCreditGuard.findOne({ depositId: deposit._id })).status).toBe('COMPLETED');
        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.APPROVED);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('safely resumes concurrent workers on the standalone-Mongo recovery path', async () => {
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );

        const results = await Promise.all([
            depositService.resumeDepositApproval(deposit._id),
            depositService.resumeDepositApproval(deposit._id),
        ]);
        expect(results).toHaveLength(2);
        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.APPROVED);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('safely resumes from two independent Backend processes', async () => {
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        const results = await Promise.all([
            runApprovalWorker(deposit._id),
            runApprovalWorker(deposit._id),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.APPROVED);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('blocks wallet currency changes while a deposit approval reservation is active', async () => {
        await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'EGP', platformRate: 50, isActive: true });
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        await User.updateOne({ _id: customer._id }, { $addToSet: { pendingDepositApprovals: deposit._id } });

        await expect(adminUsersService.updateUserCurrency(customer._id, 'EGP', admin._id))
            .rejects.toMatchObject({ code: 'WALLET_CURRENCY_CHANGE_BLOCKED' });
        expect((await User.findById(customer._id)).currency).toBe('USD');
        expect((await User.findById(customer._id)).walletBalance).toBe(0);
    });

    it('blocks every legacy wallet mutation while a different wallet operation owns the reservation', async () => {
        const leaseUntil = new Date(Date.now() + 60_000);
        await User.updateOne({ _id: customer._id }, { $set: {
            walletBalance: -20,
            creditUsed: 20,
            activeWalletOperation: {
                operationKey: 'test:held-wallet-operation',
                leaseOwner: 'test-worker',
                leaseToken: 'current-fence-token',
                leaseUntil,
                status: 'PREPARED',
                amount: 10,
                currency: 'USD',
            },
        } });

        const operations = [
            walletService.debitWalletAtomic({ userId: customer._id, amount: 10 }),
            walletService.forcedDebitWallet({ userId: customer._id, amount: 10 }),
            walletService.refundWalletAtomic({ userId: customer._id, walletDeducted: 10, creditUsedAmount: 0 }),
            walletService.creditWalletDirect({ userId: customer._id, amount: 10 }),
            adminWalletService.addFunds(customer._id, 10, 'test', admin._id),
            adminWalletService.deductFunds(customer._id, 10, 'test', admin._id),
            adminWalletService.setBalance(customer._id, 10, 'test', admin._id),
            adminUsersService.updateUserCurrency(customer._id, 'EGP', admin._id),
        ];

        const results = await Promise.allSettled(operations);
        expect(results.every((result) => result.status === 'rejected')).toBe(true);
        expect(results.map((result) => result.reason.code)).toEqual(expect.arrayContaining([
            'WALLET_OPERATION_PENDING',
            'WALLET_CURRENCY_CHANGE_BLOCKED',
        ]));
        const inflation = await adminWalletService.adjustNegativeBalancesForInflation(10, admin._id);
        const deflation = await adminWalletService.adjustNegativeBalancesForDeflation(10, admin._id);
        expect(inflation.usersAdjusted).toBe(0);
        expect(inflation.errors[0].error).toContain('Another wallet operation');
        expect(deflation.usersAdjusted).toBe(0);
        expect(deflation.errors[0].error).toContain('Another wallet operation');
        const freshUser = await User.findById(customer._id).select('+activeWalletOperation');
        expect(freshUser.walletBalance).toBe(-20);
        expect(freshUser.activeWalletOperation.leaseToken).toBe('current-fence-token');
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('reclaims an expired guard lease with a new fencing token and rejects writes from the stale token', async () => {
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        const oldToken = 'expired-worker-token';
        await DepositCreditGuard.create({
            idempotencyKey: `deposit:${deposit._id}:credit`,
            depositId: deposit._id,
            userId: customer._id,
            amount: 500,
            currency: 'USD',
            status: 'PREPARED',
            leaseOwner: 'old-worker',
            leaseToken: oldToken,
            leaseUntil: new Date(0),
        });
        await User.updateOne({ _id: customer._id }, { $set: {
            activeWalletOperation: {
                operationKey: `deposit:${deposit._id}:credit`,
                depositId: deposit._id,
                leaseOwner: 'old-worker',
                leaseToken: oldToken,
                leaseUntil: new Date(0),
                status: 'PREPARED',
                amount: 500,
                currency: 'USD',
            },
        } });

        await depositService.resumeDepositApproval(deposit._id);
        const staleWrite = await User.updateOne(
            { _id: customer._id, 'activeWalletOperation.leaseToken': oldToken, 'activeWalletOperation.status': 'PREPARED' },
            { $inc: { walletBalance: 500 }, $set: { 'activeWalletOperation.status': 'APPLIED' } }
        );
        expect(staleWrite.matchedCount).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });

    it('does not credit using an old currency snapshot after wallet currency changes', async () => {
        await Currency.create({ code: 'EGP', name: 'Egyptian Pound', symbol: 'EGP', platformRate: 50, isActive: true });
        await DepositRequest.updateOne(
            { _id: deposit._id, status: DEPOSIT_STATUS.PENDING },
            { $set: {
                status: DEPOSIT_STATUS.CREDIT_PENDING,
                reviewedBy: admin._id,
                reviewedAt: new Date(),
                approvalCreditAmount: 500,
                approvalCreditCurrency: 'USD',
                approvalConversionNote: '500 USD (direct)',
            } }
        );
        await User.updateOne({ _id: customer._id }, { $set: { currency: 'EGP' } });

        await expect(depositService.resumeDepositApproval(deposit._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_WALLET_CURRENCY_CHANGED' });
        const updatedDeposit = await DepositRequest.findById(deposit._id);
        expect(updatedDeposit.status).toBe(DEPOSIT_STATUS.CREDIT_PENDING);
        expect(updatedDeposit.approvalRecoveryError).toBe('DEPOSIT_WALLET_CURRENCY_CHANGED');
        expect((await User.findById(customer._id)).walletBalance).toBe(0);
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(0);
    });

    it('verifies the live test-database unique idempotency index before standalone approval', async () => {
        const result = await depositService.ensureDepositIdempotencyIndexReady();
        expect(result.ready).toBe(true);
        const index = (await WalletTransaction.collection.indexes()).find((candidate) => (
            candidate.unique === true
            && Object.keys(candidate.key || {}).length === 1
            && candidate.key.idempotencyKey === 1
            && candidate.partialFilterExpression?.idempotencyKey?.$type === 'string'
        ));
        expect(index).toBeDefined();
    });

    it('blocks index creation when duplicate idempotency keys exist and preserves those rows', async () => {
        const index = (await WalletTransaction.collection.indexes()).find((candidate) => candidate.key?.idempotencyKey === 1);
        expect(index).toBeDefined();
        await WalletTransaction.collection.dropIndex(index.name);
        const key = `deposit:test-duplicate-${deposit._id}`;
        await WalletTransaction.create([
            { userId: customer._id, type: 'CREDIT', amount: 1, balanceBefore: 0, balanceAfter: 1, idempotencyKey: key },
            { userId: customer._id, type: 'CREDIT', amount: 1, balanceBefore: 1, balanceAfter: 2, idempotencyKey: key },
        ]);

        try {
            const result = await depositService.ensureDepositIdempotencyIndexReady();
            expect(result.ready).toBe(false);
            expect(result.reason).toBe('DUPLICATE_IDEMPOTENCY_KEYS');
            expect(result.duplicateKeys[0].idempotencyKey).toBe(key);
            expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(2);
            expect((await WalletTransaction.collection.indexes()).some((candidate) => candidate.name === index.name)).toBe(false);
        } finally {
            await WalletTransaction.deleteMany({ idempotencyKey: key });
            await WalletTransaction.collection.createIndex(index.key, {
                unique: true,
                partialFilterExpression: { idempotencyKey: { $type: 'string' } },
            });
        }
    });

    it('keeps wallet balance consistent with the deposit credit ledger', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const user = await User.findById(customer._id);
        const transactions = await WalletTransaction.find({ userId: customer._id, type: 'CREDIT' }).sort({ balanceBefore: 1 });
        const credited = transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
        expect(user.walletBalance).toBe(credited);
        expect(transactions[0].balanceAfter - transactions[0].balanceBefore).toBe(transactions[0].amount);
    });

    it('rounds wallet credits deterministically to currency precision', async () => {
        const first = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 0.1,
            amountUsd: 0.1,
        });
        const second = await depositService.createDepositRequest({
            userId: customer._id,
            ...VALID_DEPOSIT,
            requestedAmount: 0.2,
            amountUsd: 0.2,
        });
        await depositService.approveDeposit(first._id, admin._id);
        await depositService.approveDeposit(second._id, admin._id);

        const user = await User.findById(customer._id);
        const transactions = await WalletTransaction.find({ userId: customer._id, type: 'CREDIT' }).sort({ balanceBefore: 1 });
        expect(user.walletBalance).toBe(0.3);
        expect(transactions.map((transaction) => transaction.balanceAfter)).toEqual([0.1, 0.3]);
    });

    it('never creates duplicate transaction records for a deposit credit key', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        await expect(WalletTransaction.create({
            userId: customer._id,
            type: 'CREDIT',
            amount: 500,
            balanceBefore: 500,
            balanceAfter: 1000,
            reference: deposit._id,
            idempotencyKey: `deposit:${deposit._id}:credit`,
        })).rejects.toMatchObject({ code: 11000 });
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
    });
});
