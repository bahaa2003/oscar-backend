'use strict';

const mongoose = require('mongoose');

const { REFERRAL_SOURCE } = require('../modules/users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
} = require('../modules/referrals/referralCommission.model');
const {
    ReferralPayoutRequest,
    PAYOUT_METHOD,
    PAYOUT_STATUS,
} = require('../modules/referrals/referralPayoutRequest.model');
const {
    getAdminReferralDashboard,
} = require('../modules/referrals/referralAdminDashboard.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createGroup,
} = require('./testHelpers');

const uniqueEmail = (prefix = 'admin-referral') =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

const createInvitee = (referrer, groupId, overrides = {}) => createCustomer({
    groupId,
    name: overrides.name || 'Real Invitee',
    email: overrides.email || uniqueEmail('invitee'),
    referredBy: referrer._id,
    referredAt: overrides.referredAt || new Date('2026-01-10T00:00:00.000Z'),
    referralSource: overrides.referralSource || REFERRAL_SOURCE.EMAIL_REGISTRATION,
});

const createCommission = ({
    referrer,
    invitee,
    sourceAmountUsd = '100.00',
    commissionAmountUsd = '5.00',
    status = COMMISSION_STATUS.AVAILABLE,
} = {}) => ReferralCommission.create({
    referrerId: referrer._id,
    referredUserId: invitee._id,
    depositId: new mongoose.Types.ObjectId(),
    walletTransactionId: new mongoose.Types.ObjectId(),
    sourceAmount: sourceAmountUsd,
    sourceCurrency: 'USD',
    sourceExchangeRate: '1',
    sourceAmountUsd,
    commissionRatePercent: '5',
    commissionAmountUsd,
    commissionAmount: commissionAmountUsd,
    commissionCurrency: 'USD',
    referrerCurrency: 'USD',
    referrerExchangeRateFromUsd: '1',
    status,
    availableAt: new Date('2026-02-01T00:00:00.000Z'),
    paidAt: status === COMMISSION_STATUS.PAID ? new Date('2026-02-03T00:00:00.000Z') : null,
    referralSource: invitee.referralSource,
    referredAt: invitee.referredAt,
    idempotencyKey: `admin-referral-dashboard:${new mongoose.Types.ObjectId()}`,
});

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('admin referral dashboard source of truth', () => {
    test('returns only real referral owners, invitees, commission totals, and paid withdrawals', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({
            groupId: group._id,
            name: 'Real Owner',
            email: uniqueEmail('owner'),
            referralCode: 'ABCDEFGHJK',
        });
        const otherUser = await createCustomer({
            groupId: group._id,
            name: 'Unrelated User',
            email: uniqueEmail('unrelated'),
            referralCode: 'LMNPQRSTUV',
        });

        const inviteeA = await createInvitee(referrer, group._id, {
            name: 'Real Invitee A',
            email: uniqueEmail('invitee-a'),
        });
        const inviteeB = await createInvitee(referrer, group._id, {
            name: 'Real Invitee B',
            email: uniqueEmail('invitee-b'),
            referralSource: REFERRAL_SOURCE.GOOGLE_OAUTH,
        });

        const commissionA = await createCommission({
            referrer,
            invitee: inviteeA,
            sourceAmountUsd: '120.00',
            commissionAmountUsd: '6.00',
            status: COMMISSION_STATUS.PAID,
        });
        await createCommission({
            referrer,
            invitee: inviteeB,
            sourceAmountUsd: '80.00',
            commissionAmountUsd: '4.00',
        });
        await ReferralPayoutRequest.create({
            referrerId: referrer._id,
            commissionIds: [commissionA._id],
            amountUsd: '6.00',
            amount: '6.00',
            currency: 'USD',
            method: PAYOUT_METHOD.WALLET,
            status: PAYOUT_STATUS.PAID,
            idempotencyKey: `admin-referral-dashboard-payout:${new mongoose.Types.ObjectId()}`,
            requestedAt: new Date('2026-02-04T00:00:00.000Z'),
            reviewedAt: new Date('2026-02-05T00:00:00.000Z'),
            paidAt: new Date('2026-02-05T00:00:00.000Z'),
            requestSnapshot: {
                commissionCount: 1,
                amountUsd: '6.00',
                commissionIds: [commissionA._id],
            },
        });

        const dashboard = await getAdminReferralDashboard();

        expect(dashboard.summary).toMatchObject({
            owners: 1,
            invited: 2,
            deposits: 200,
            earnings: 10,
            withdrawn: 6,
            currency: 'USD',
        });
        expect(dashboard.owners).toHaveLength(1);
        expect(dashboard.owners[0]).toMatchObject({
            name: 'Real Owner',
            email: referrer.email,
            code: 'ABCDEFGHJK',
            deposits: '200.00',
            earnings: '10.00',
            withdrawn: '6.00',
        });
        expect(dashboard.owners[0].referrals.map((user) => user.email).sort()).toEqual(
            [inviteeA.email, inviteeB.email].sort()
        );
        expect(dashboard.owners[0].referrals.map((user) => user.email)).not.toContain(otherUser.email);
    });

    test('returns a valid empty state when no referral records exist', async () => {
        const dashboard = await getAdminReferralDashboard();

        expect(dashboard).toMatchObject({
            summary: {
                owners: 0,
                invited: 0,
                deposits: 0,
                earnings: 0,
                withdrawn: 0,
                currency: 'EGP',
            },
            owners: [],
        });
    });
});
