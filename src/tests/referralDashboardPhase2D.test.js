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
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
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

const apiGet = async (path, { token } = {}) => {
    const response = await axios.get(`${baseURL}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        validateStatus: () => true,
        proxy: false,
    });
    return response;
};

const createReferredUser = async (referrer, overrides = {}) => {
    const payload = {
        referredBy: referrer._id,
        referredAt: overrides.referredAt || new Date('2026-01-10T10:00:00.000Z'),
        referralSource: overrides.referralSource || REFERRAL_SOURCE.EMAIL_REGISTRATION,
        groupId: overrides.groupId,
    };

    for (const field of ['email', 'name', 'status', 'deletedAt']) {
        if (Object.prototype.hasOwnProperty.call(overrides, field)) {
            payload[field] = overrides[field];
        }
    }

    return createCustomer(payload);
};

const createCommission = async ({
    referrer,
    invitee,
    status = COMMISSION_STATUS.AVAILABLE,
    amount = '5.00',
    sourceAmount = '100.00',
    createdAt = new Date(),
} = {}) => {
    const commission = await ReferralCommission.create({
        referrerId: referrer._id,
        referredUserId: invitee._id,
        depositId: new mongoose.Types.ObjectId(),
        walletTransactionId: new mongoose.Types.ObjectId(),
        sourceAmount,
        sourceCurrency: 'USD',
        sourceExchangeRate: '1',
        sourceAmountUsd: sourceAmount,
        commissionRatePercent: '5',
        commissionAmountUsd: amount,
        commissionCurrency: 'USD',
        status,
        availableAt: createdAt,
        lockedAt: null,
        paidAt: null,
        cancelledAt: null,
        referralSource: invitee.referralSource || REFERRAL_SOURCE.EMAIL_REGISTRATION,
        referredAt: invitee.referredAt || new Date('2026-01-10T10:00:00.000Z'),
        idempotencyKey: `phase2d:${new mongoose.Types.ObjectId()}`,
    });

    await ReferralCommission.updateOne(
        { _id: commission._id },
        { $set: { createdAt, updatedAt: createdAt } },
        { timestamps: false }
    );

    return ReferralCommission.findById(commission._id).lean();
};

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Phase 2D referral dashboard APIs', () => {
    test('dashboard returns own referral code, relative share path, invitee count, and Decimal string totals', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({
            groupId: group._id,
            referralCode: 'DASHCODE8',
        });
        const otherReferrer = await createCustomer({ groupId: group._id, referralCode: 'OTHERCD8' });
        const inviteeA = await createReferredUser(referrer, {
            groupId: group._id,
            name: 'Invitee A',
            email: 'invitee.a@example.com',
        });
        const inviteeB = await createReferredUser(referrer, {
            groupId: group._id,
            name: 'Invitee B',
            email: 'invitee.b@example.com',
        });
        await createReferredUser(otherReferrer, { groupId: group._id });

        await createCommission({ referrer, invitee: inviteeA, status: COMMISSION_STATUS.AVAILABLE, amount: '10.50' });
        await createCommission({ referrer, invitee: inviteeA, status: COMMISSION_STATUS.LOCKED, amount: '2.25' });
        await createCommission({ referrer, invitee: inviteeB, status: COMMISSION_STATUS.PAID, amount: '3.75' });
        await createCommission({ referrer: otherReferrer, invitee: inviteeB, amount: '99.00' });

        const response = await apiGet('/referrals/me/dashboard', { token: tokenFor(referrer) });

        expect(response.status).toBe(200);
        expect(response.data.success).toBe(true);
        expect(response.data.data.referral).toEqual({
            code: 'DASHCODE8',
            sharePath: '/auth?mode=signup&ref=DASHCODE8',
        });
        expect(response.data.data.referrals.total).toBe(2);
        expect(response.data.data.commissions).toEqual({
            count: 3,
            currency: 'USD',
            totals: {
                available: '10.50',
                locked: '2.25',
                paid: '3.75',
                cancelled: '0.00',
            },
        });
        expect(typeof response.data.data.commissions.totals.available).toBe('string');
    });

    test('dashboard for an empty account returns zeros without exposing referral ownership internals', async () => {
        const referrer = await createCustomer({ groupId: (await createGroup())._id, referralCode: 'EMPTYCD8' });

        const response = await apiGet('/referrals/me/dashboard', { token: tokenFor(referrer) });

        expect(response.status).toBe(200);
        expect(response.data.data.referral.code).toBe('EMPTYCD8');
        expect(response.data.data.referrals.total).toBe(0);
        expect(response.data.data.commissions.count).toBe(0);
        expect(response.data.data.commissions.totals.available).toBe('0.00');
        expect(response.data.data).not.toHaveProperty('referredBy');
    });

    test('commission history is isolated to the current referrer and supports status, date, pagination, and stable ordering', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const otherReferrer = await createCustomer({ groupId: group._id });
        const invitee = await createReferredUser(referrer, { groupId: group._id });

        const older = await createCommission({
            referrer,
            invitee,
            amount: '1.00',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
        });
        const newer = await createCommission({
            referrer,
            invitee,
            amount: '2.00',
            createdAt: new Date('2026-02-02T00:00:00.000Z'),
        });
        await createCommission({
            referrer,
            invitee,
            status: COMMISSION_STATUS.PAID,
            amount: '3.00',
            createdAt: new Date('2026-02-03T00:00:00.000Z'),
        });
        await createCommission({
            referrer: otherReferrer,
            invitee,
            amount: '99.00',
            createdAt: new Date('2026-02-04T00:00:00.000Z'),
        });

        const response = await apiGet(
            '/referrals/me/commissions?status=AVAILABLE&page=1&limit=1&dateFrom=2020-01-01T00:00:00.000Z&dateTo=2030-01-01T00:00:00.000Z',
            { token: tokenFor(referrer) }
        );

        expect(response.status).toBe(200);
        expect(response.data.data.items).toHaveLength(1);
        expect(response.data.data.items[0].id).toBe(String(newer._id));
        expect(response.data.data.items[0].commissionAmountUsd).toBe('2.00');
        expect(response.data.data.items[0]).not.toHaveProperty('referredUserId');
        expect(response.data.data.items[0]).not.toHaveProperty('referrerId');
        expect(response.data.data.items[0]).not.toHaveProperty('idempotencyKey');
        expect(response.data.data.pagination).toEqual({
            page: 1,
            limit: 1,
            total: 2,
            pages: 2,
        });

        const pageTwo = await apiGet('/referrals/me/commissions?status=AVAILABLE&page=2&limit=1', {
            token: tokenFor(referrer),
        });
        expect(pageTwo.data.data.items[0].id).toBe(String(older._id));
    });

    test('commission and invitee filters reject invalid values before service execution', async () => {
        const referrer = await createCustomer({ groupId: (await createGroup())._id });

        const invalidStatus = await apiGet('/referrals/me/commissions?status=unknown', {
            token: tokenFor(referrer),
        });
        const invalidLimit = await apiGet('/referrals/me/commissions?limit=101', {
            token: tokenFor(referrer),
        });
        const invalidDateRange = await apiGet(
            '/referrals/me/invitees?dateFrom=2026-02-10T00:00:00.000Z&dateTo=2026-02-01T00:00:00.000Z',
            { token: tokenFor(referrer) }
        );
        const invalidSource = await apiGet('/referrals/me/invitees?source=ADMIN_PANEL', {
            token: tokenFor(referrer),
        });

        expect(invalidStatus.status).toBe(400);
        expect(invalidLimit.status).toBe(400);
        expect(invalidDateRange.status).toBe(400);
        expect(invalidSource.status).toBe(400);
    });

    test('invitee history is privacy-safe, excludes deleted users, supports filters, and groups commission totals without N+1 queries', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const otherReferrer = await createCustomer({ groupId: group._id });
        const emailInvitee = await createReferredUser(referrer, {
            groupId: group._id,
            name: 'Email Invitee',
            email: 'alice.private@example.com',
            referredAt: new Date('2026-03-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });
        const googleInvitee = await createReferredUser(referrer, {
            groupId: group._id,
            name: 'Google Invitee',
            email: 'google.private@example.com',
            referredAt: new Date('2026-03-02T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.GOOGLE_OAUTH,
        });
        await createReferredUser(referrer, {
            groupId: group._id,
            email: 'deleted@example.com',
            deletedAt: new Date('2026-03-03T00:00:00.000Z'),
        });
        await createReferredUser(otherReferrer, { groupId: group._id });

        await createCommission({ referrer, invitee: emailInvitee, amount: '4.25' });
        await createCommission({ referrer, invitee: emailInvitee, status: COMMISSION_STATUS.PAID, amount: '6.00' });
        await createCommission({ referrer, invitee: googleInvitee, amount: '8.00' });
        const aggregateSpy = jest.spyOn(ReferralCommission, 'aggregate');

        const response = await apiGet(
            '/referrals/me/invitees?source=EMAIL_REGISTRATION&page=1&limit=10&dateFrom=2026-03-01T00:00:00.000Z&dateTo=2026-03-01T23:59:59.999Z',
            { token: tokenFor(referrer) }
        );

        expect(response.status).toBe(200);
        expect(response.data.data.items).toHaveLength(1);
        expect(response.data.data.pagination.total).toBe(1);
        const item = response.data.data.items[0];
        expect(item.id).toBe(String(emailInvitee._id));
        expect(item.displayName).toBe('Email Invitee');
        expect(item.maskedEmail).toBe('a***@example.com');
        expect(item).not.toHaveProperty('email');
        expect(item).not.toHaveProperty('phone');
        expect(item).not.toHaveProperty('walletBalance');
        expect(item).not.toHaveProperty('status');
        expect(item.commissionSummary).toEqual({
            count: 2,
            totalAvailableUsd: '4.25',
        });
        expect(aggregateSpy).toHaveBeenCalledTimes(1);
        aggregateSpy.mockRestore();
    });

    test('authorization rejects unauthenticated/inactive users and client-supplied ownership overrides', async () => {
        const group = await createGroup();
        const activeUser = await createCustomer({ groupId: group._id });
        const inactiveUser = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });
        const admin = await createAdmin({ groupId: group._id });
        const otherReferrer = await createCustomer({ groupId: group._id });

        const unauthenticated = await apiGet('/referrals/me/dashboard');
        const inactive = await apiGet('/referrals/me/dashboard', { token: tokenFor(inactiveUser) });
        const ownershipOverride = await apiGet(`/referrals/me/dashboard?referrerId=${otherReferrer._id}`, {
            token: tokenFor(activeUser),
        });
        const adminOverride = await apiGet(`/referrals/me/commissions?referrerId=${otherReferrer._id}`, {
            token: tokenFor(admin),
        });

        expect(unauthenticated.status).toBe(401);
        expect(inactive.status).toBe(401);
        expect(ownershipOverride.status).toBe(400);
        expect(adminOverride.status).toBe(400);
    });

    test('dashboard APIs are read-only: no payout, commission mutation, wallet credit, or referral relation changes', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 123.45 });
        const invitee = await createReferredUser(referrer, { groupId: group._id });
        const commission = await createCommission({ referrer, invitee, amount: '7.00' });

        await apiGet('/referrals/me/dashboard', { token: tokenFor(referrer) });
        await apiGet('/referrals/me/commissions', { token: tokenFor(referrer) });
        await apiGet('/referrals/me/invitees', { token: tokenFor(referrer) });

        const freshReferrer = await User.findById(referrer._id).lean();
        const freshInvitee = await User.findById(invitee._id).select('+referredBy').lean();
        const freshCommission = await ReferralCommission.findById(commission._id).lean();

        expect(freshReferrer.walletBalance).toBe(123.45);
        expect(String(freshInvitee.referredBy)).toBe(String(referrer._id));
        expect(freshCommission.status).toBe(COMMISSION_STATUS.AVAILABLE);
        expect(await WalletTransaction.countDocuments({ userId: referrer._id })).toBe(0);
    });
});
