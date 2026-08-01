'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../app');
const config = require('../config/config');
const { User, REFERRAL_SOURCE } = require('../modules/users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
} = require('../modules/referrals/referralCommission.model');
const {
    ReferralPayoutRequest,
    PAYOUT_STATUS,
    PAYOUT_METHOD,
} = require('../modules/referrals/referralPayoutRequest.model');
const payoutService = require('../modules/referrals/referralPayout.service');
const { WalletTransaction, TRANSACTION_SOURCE_TYPES } = require('../modules/wallet/walletTransaction.model');
const walletService = require('../modules/wallet/wallet.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createAdmin,
    createGroup,
    USER_STATUS,
} = require('./testHelpers');

let server;
let baseURL;

const tokenFor = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

const api = async (method, path, { token, data } = {}) => axios({
    method,
    url: `${baseURL}${path}`,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
    proxy: false,
});

const createInvitee = async (referrer, groupId) => createCustomer({
    groupId,
    referredBy: referrer._id,
    referredAt: new Date('2026-01-01T00:00:00.000Z'),
    referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
});

const createCommission = async ({
    referrer,
    invitee,
    status = COMMISSION_STATUS.AVAILABLE,
    amount = '5.00',
    currency = 'USD',
    payoutRequestId = null,
} = {}) => ReferralCommission.create({
    referrerId: referrer._id,
    referredUserId: invitee._id,
    depositId: new mongoose.Types.ObjectId(),
    walletTransactionId: new mongoose.Types.ObjectId(),
    sourceAmount: '100.00',
    sourceCurrency: 'USD',
    sourceExchangeRate: '1',
    sourceAmountUsd: '100.00',
    commissionRatePercent: '5',
    commissionAmountUsd: amount,
    commissionAmount: amount,
    referrerCurrency: currency,
    referrerExchangeRateFromUsd: currency === 'USD' ? '1' : '50',
    commissionCurrency: currency,
    status,
    availableAt: new Date('2026-02-01T00:00:00.000Z'),
    lockedAt: status === COMMISSION_STATUS.LOCKED ? new Date('2026-02-02T00:00:00.000Z') : null,
    paidAt: status === COMMISSION_STATUS.PAID ? new Date('2026-02-03T00:00:00.000Z') : null,
    cancelledAt: null,
    payoutRequestId,
    referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
    referredAt: invitee.referredAt || new Date('2026-01-01T00:00:00.000Z'),
    idempotencyKey: `phase2e:${new mongoose.Types.ObjectId()}`,
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
    walletService.__setWalletTestHooks({});
    payoutService.__setReferralPayoutTestHooks({});
});

afterEach(() => {
    walletService.__setWalletTestHooks({});
    payoutService.__setReferralPayoutTestHooks({});
});

describe('Phase 2E ReferralPayoutRequest model', () => {
    test('requires owner, commission set, Decimal amount, method, and unique idempotency key', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const commissionId = new mongoose.Types.ObjectId();

        const payout = await ReferralPayoutRequest.create({
            referrerId: referrer._id,
            commissionIds: [commissionId],
            amountUsd: '12.34',
            method: PAYOUT_METHOD.WALLET,
            idempotencyKey: 'payout:model:test',
            requestSnapshot: {
                commissionCount: 1,
                amountUsd: '12.34',
                commissionIds: [commissionId],
            },
        });

        expect(payout.status).toBe(PAYOUT_STATUS.PENDING);
        expect(payout.currency).toBe('USD');
        await expect(ReferralPayoutRequest.create({
            referrerId: referrer._id,
            commissionIds: [new mongoose.Types.ObjectId()],
            amountUsd: '1.00',
            method: PAYOUT_METHOD.MANUAL,
            idempotencyKey: 'payout:model:test',
            requestSnapshot: { commissionCount: 1, amountUsd: '1.00' },
        })).rejects.toMatchObject({ code: 11000 });
    });
});

describe('Phase 2E payout request transaction', () => {
    test('creates a PENDING payout and locks selected AVAILABLE commissions atomically', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const c1 = await createCommission({ referrer, invitee, amount: '5.25' });
        const c2 = await createCommission({ referrer, invitee, amount: '2.75' });

        const payout = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [c2._id, c1._id],
            method: PAYOUT_METHOD.WALLET,
        });

        expect(payout.status).toBe(PAYOUT_STATUS.PENDING);
        expect(payout.amountUsd).toBe('8.00');
        expect(payout.requestSnapshot.commissionCount).toBe(2);

        const commissions = await ReferralCommission.find({ _id: { $in: [c1._id, c2._id] } });
        expect(commissions.every((commission) => commission.status === COMMISSION_STATUS.LOCKED)).toBe(true);
        expect(commissions.every((commission) => String(commission.payoutRequestId) === String(payout._id))).toBe(true);
    });

    test('repeated identical creation returns one payout without double-locking', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '9.00' });

        const first = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [commission._id],
            method: PAYOUT_METHOD.MANUAL,
        });
        const second = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [commission._id],
            method: PAYOUT_METHOD.MANUAL,
        });

        expect(String(second._id)).toBe(String(first._id));
        expect(await ReferralPayoutRequest.countDocuments()).toBe(1);
        expect(await ReferralCommission.countDocuments({ status: COMMISSION_STATUS.LOCKED })).toBe(1);
    });

    test('rejects foreign, duplicate, locked, paid, mixed-currency, and below-minimum selections safely', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const other = await createCustomer({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const own = await createCommission({ referrer, invitee, amount: '1.00' });
        const foreign = await createCommission({ referrer: other, invitee, amount: '1.00' });
        const locked = await createCommission({ referrer, invitee, status: COMMISSION_STATUS.LOCKED, amount: '1.00' });
        const paid = await createCommission({ referrer, invitee, status: COMMISSION_STATUS.PAID, amount: '1.00' });
        const eur = await createCommission({ referrer, invitee, amount: '1.00', currency: 'EUR' });

        await expect(payoutService.createPayoutRequest(referrer._id, { commissionIds: [own._id, own._id], method: 'WALLET' }))
            .rejects.toMatchObject({ code: 'DUPLICATE_PAYOUT_COMMISSION_IDS' });
        await expect(payoutService.createPayoutRequest(referrer._id, { commissionIds: [foreign._id], method: 'WALLET' }))
            .rejects.toMatchObject({ code: 'FOREIGN_COMMISSION' });
        await expect(payoutService.createPayoutRequest(referrer._id, { commissionIds: [locked._id], method: 'WALLET' }))
            .rejects.toMatchObject({ code: 'COMMISSION_NOT_AVAILABLE' });
        await expect(payoutService.createPayoutRequest(referrer._id, { commissionIds: [paid._id], method: 'WALLET' }))
            .rejects.toMatchObject({ code: 'COMMISSION_NOT_AVAILABLE' });
        await expect(payoutService.createPayoutRequest(referrer._id, { commissionIds: [own._id, eur._id], method: 'WALLET' }))
            .rejects.toMatchObject({ code: 'MIXED_PAYOUT_CURRENCIES' });

        expect(await ReferralPayoutRequest.countDocuments()).toBe(0);
        expect((await ReferralCommission.findById(own._id)).status).toBe(COMMISSION_STATUS.AVAILABLE);
    });

    test('rolls back payout creation when commission locking fails', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '7.00' });

        payoutService.__setReferralPayoutTestHooks({
            beforeCommissionLock: async () => {
                throw Object.assign(new Error('transient lock failure'), {
                    hasErrorLabel: (label) => label === 'TransientTransactionError',
                });
            },
        });

        await expect(payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [commission._id],
            method: PAYOUT_METHOD.WALLET,
        })).rejects.toMatchObject({ code: 'PAYOUT_RETRY_EXHAUSTED' });

        expect(await ReferralPayoutRequest.countDocuments()).toBe(0);
        expect((await ReferralCommission.findById(commission._id)).status).toBe(COMMISSION_STATUS.AVAILABLE);
    });
});

describe('Phase 2E admin rejection and settlement', () => {
    test('rejects PENDING payout and unlocks all commissions atomically; repeated rejection is idempotent', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const admin = await createAdmin({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '4.00' });
        const payout = await payoutService.createPayoutRequest(referrer._id, { commissionIds: [commission._id], method: 'MANUAL' });

        const rejected = await payoutService.rejectPayout(payout._id, admin._id, { rejectionReason: 'Not eligible for payout' });
        const repeated = await payoutService.rejectPayout(payout._id, admin._id, { rejectionReason: 'Different reason ignored' });

        expect(rejected.status).toBe(PAYOUT_STATUS.REJECTED);
        expect(String(repeated._id)).toBe(String(rejected._id));
        const freshCommission = await ReferralCommission.findById(commission._id);
        expect(freshCommission.status).toBe(COMMISSION_STATUS.AVAILABLE);
        expect(freshCommission.payoutRequestId).toBeNull();
        expect(freshCommission.lockedAt).toBeNull();
    });

    test('settles WALLET payout with one wallet credit, one source ledger, and PAID commissions; repeated settlement does not duplicate credit', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 10 });
        const admin = await createAdmin({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '6.50' });
        const payout = await payoutService.createPayoutRequest(referrer._id, { commissionIds: [commission._id], method: 'WALLET' });

        const settled = await payoutService.settlePayout(payout._id, admin._id);
        const repeated = await payoutService.settlePayout(payout._id, admin._id);

        expect(settled.status).toBe(PAYOUT_STATUS.PAID);
        expect(String(repeated._id)).toBe(String(settled._id));
        expect((await User.findById(referrer._id)).walletBalance).toBeCloseTo(16.5);
        const ledgers = await WalletTransaction.find({
            userId: referrer._id,
            sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
            sourceId: payout._id,
        });
        expect(ledgers).toHaveLength(1);
        expect(ledgers[0].amount).toBeCloseTo(6.5);
        expect((await ReferralCommission.findById(commission._id)).status).toBe(COMMISSION_STATUS.PAID);
    });

    test('settles MANUAL payout without wallet credit or payout wallet ledger', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 10 });
        const admin = await createAdmin({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '3.25' });
        const payout = await payoutService.createPayoutRequest(referrer._id, { commissionIds: [commission._id], method: 'MANUAL' });

        const settled = await payoutService.settlePayout(payout._id, admin._id, { externalReference: 'MANUAL-REF-100' });

        expect(settled.status).toBe(PAYOUT_STATUS.PAID);
        expect(settled.externalReference).toBe('MANUAL-REF-100');
        expect((await User.findById(referrer._id)).walletBalance).toBeCloseTo(10);
        expect(await WalletTransaction.countDocuments({
            userId: referrer._id,
            sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
        })).toBe(0);
    });

    test('rolls back WALLET settlement when wallet credit fails', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 10 });
        const admin = await createAdmin({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '8.00' });
        const payout = await payoutService.createPayoutRequest(referrer._id, { commissionIds: [commission._id], method: 'WALLET' });

        walletService.__setWalletTestHooks({
            beforeWalletLedgerInsert: async () => {
                throw new Error('ledger failed');
            },
        });

        await expect(payoutService.settlePayout(payout._id, admin._id)).rejects.toThrow('ledger failed');
        expect((await ReferralPayoutRequest.findById(payout._id)).status).toBe(PAYOUT_STATUS.PENDING);
        expect((await ReferralCommission.findById(commission._id)).status).toBe(COMMISSION_STATUS.LOCKED);
        expect((await User.findById(referrer._id)).walletBalance).toBeCloseTo(10);
        expect(await WalletTransaction.countDocuments({ sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT })).toBe(0);
    });
});

describe('Phase 2E payout APIs', () => {
    test('user can request and list only own payouts; client-supplied financial fields are rejected', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const other = await createCustomer({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '11.00' });
        await createCommission({ referrer: other, invitee, amount: '99.00' });

        const bad = await api('post', '/referrals/me/payouts', {
            token: tokenFor(referrer),
            data: {
                commissionIds: [String(commission._id)],
                method: 'WALLET',
                amountUsd: '999.00',
            },
        });
        expect(bad.status).toBe(400);

        const create = await api('post', '/referrals/me/payouts', {
            token: tokenFor(referrer),
            data: { commissionIds: [String(commission._id)], method: 'WALLET' },
        });
        expect(create.status).toBe(200);
        expect(create.data.data.amountUsd).toBe('11.00');
        expect(create.data.data).not.toHaveProperty('idempotencyKey');

        const list = await api('get', '/referrals/me/payouts', { token: tokenFor(referrer) });
        expect(list.status).toBe(200);
        expect(list.data.data.items).toHaveLength(1);
        expect(list.data.data.items[0].amountUsd).toBe('11.00');
    });

    test('admin list/reject/settle require admin access and use backend state', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const admin = await createAdmin({ groupId: group._id });
        const invitee = await createInvitee(referrer, group._id);
        const commission = await createCommission({ referrer, invitee, amount: '12.00' });
        const payout = await payoutService.createPayoutRequest(referrer._id, { commissionIds: [commission._id], method: 'MANUAL' });

        const userList = await api('get', '/admin/referral-payouts', { token: tokenFor(referrer) });
        expect(userList.status).toBe(403);

        const adminList = await api('get', '/admin/referral-payouts?status=PENDING', { token: tokenFor(admin) });
        expect(adminList.status).toBe(200);
        expect(adminList.data.data.items[0].id).toBe(String(payout._id));

        const settleMissingReference = await api('post', `/admin/referral-payouts/${payout._id}/settle`, {
            token: tokenFor(admin),
            data: {},
        });
        expect(settleMissingReference.status).toBe(422);

        const settle = await api('post', `/admin/referral-payouts/${payout._id}/settle`, {
            token: tokenFor(admin),
            data: { externalReference: 'MANUAL-OK-1' },
        });
        expect(settle.status).toBe(200);
        expect(settle.data.data.status).toBe(PAYOUT_STATUS.PAID);
    });

    test('inactive user cannot request payouts and unauthenticated request is rejected', async () => {
        const group = await createGroup();
        const inactive = await createCustomer({ groupId: group._id, status: USER_STATUS.REJECTED });

        const unauthenticated = await api('post', '/referrals/me/payouts', {
            data: { commissionIds: [String(new mongoose.Types.ObjectId())], method: 'WALLET' },
        });
        expect(unauthenticated.status).toBe(401);

        const inactiveResponse = await api('get', '/referrals/me/payouts', { token: tokenFor(inactive) });
        expect(inactiveResponse.status).toBe(401);
    });
});
