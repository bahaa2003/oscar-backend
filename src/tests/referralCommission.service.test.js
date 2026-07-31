'use strict';

const config = require('../config/config');
const { User, USER_STATUS, RESELLER_STATUS, REFERRAL_SOURCE } = require('../modules/users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
} = require('../modules/referrals/referralCommission.model');
const commissionService = require('../modules/referrals/referralCommission.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    config.referralCommission.enabled = true;
    config.referralCommission.ratePercent = 5;
});

afterEach(() => {
    config.referralCommission.enabled = false;
    config.referralCommission.ratePercent = null;
});

const makeReferralPair = async ({ referrerOverrides = {}, referredOverrides = {} } = {}) => {
    const group = await createGroup({ percentage: 0, isDefault: true });
    const referrer = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        ...referrerOverrides,
    });
    const referredAt = new Date('2026-01-01T00:00:00.000Z');
    const referred = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        referredBy: referrer._id,
        referredAt,
        referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        ...referredOverrides,
    });
    return { referrer, referred, referredAt, group };
};

const evaluate = (referredUser, sourceAmountUsd = '100.00') =>
    commissionService.evaluateDepositCommission({
        referredUser,
        approvalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
        sourceAmountUsd,
    });

describe('referral commission eligibility', () => {
    it('returns DISABLED when the engine is disabled and creates no positive hidden default', async () => {
        const { referred } = await makeReferralPair();
        config.referralCommission.enabled = false;
        config.referralCommission.ratePercent = null;

        const result = await evaluate(referred);

        expect(result.eligible).toBe(false);
        expect(result.evaluation.outcome).toBe('DISABLED');
        expect(result.evaluation.reason).toBe('COMMISSION_DISABLED');
        expect(result.evaluation.ratePercent).toBeNull();
    });

    it('fails clearly when enabled with a missing, malformed, or out-of-range rate', async () => {
        const { referred } = await makeReferralPair();

        for (const rate of [null, undefined, '', 'abc', -1, 101]) {
            config.referralCommission.ratePercent = rate;
            await expect(evaluate(referred)).rejects.toMatchObject({
                code: 'INVALID_REFERRAL_COMMISSION_CONFIG',
            });
        }
    });

    it.each([
        ['NO_REFERRER', async () => {
            const group = await createGroup({ percentage: 0 });
            return createCustomer({ groupId: group._id, referredBy: null, referredAt: null });
        }],
        ['REFERRER_INACTIVE', async () => (await makeReferralPair({
            referrerOverrides: { status: USER_STATUS.REJECTED },
        })).referred],
        ['REFERRER_DELETED', async () => (await makeReferralPair({
            referrerOverrides: { deletedAt: new Date('2025-01-01T00:00:00.000Z') },
        })).referred],
        ['INVALID_REFERRAL_RELATION', async () => (await makeReferralPair({
            referredOverrides: { referredAt: null },
        })).referred],
        ['INVALID_REFERRAL_RELATION', async () => (await makeReferralPair({
            referredOverrides: { referredAt: new Date('2027-01-01T00:00:00.000Z') },
        })).referred],
        ['COMMISSION_STOPPED', async () => (await makeReferralPair({
            referrerOverrides: { referrerCommissionStoppedAt: new Date('2026-01-01T12:00:00.000Z') },
        })).referred],
    ])('marks expected ineligible state as %s', async (reason, buildReferred) => {
        const referred = await buildReferred();

        const result = await evaluate(referred);

        expect(result.eligible).toBe(false);
        expect(result.evaluation.outcome).toBe('NOT_ELIGIBLE');
        expect(result.evaluation.reason).toBe(reason);
    });

    it('marks self-referral as not eligible', async () => {
        const group = await createGroup({ percentage: 0 });
        const user = await createCustomer({ groupId: group._id });
        await User.updateOne(
            { _id: user._id },
            {
                $set: {
                    referredBy: user._id,
                    referredAt: new Date('2026-01-01T00:00:00.000Z'),
                    referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
                },
            }
        );
        const selfReferred = await User.findById(user._id).select('+referredBy +referredAt +referralSource');

        const result = await evaluate(selfReferred);

        expect(result.eligible).toBe(false);
        expect(result.evaluation.reason).toBe('SELF_REFERRAL');
    });

    it('does not require reseller approval and ignores Group percentage as a commission rate', async () => {
        const { referred } = await makeReferralPair({
            referrerOverrides: { resellerStatus: RESELLER_STATUS.NONE },
        });
        config.referralCommission.ratePercent = 5;

        const result = await evaluate(referred);

        expect(result.eligible).toBe(true);
        expect(result.ratePercent).toBe('5');
        expect(result.commissionAmountUsd).toBe('5.00');
    });

    it('allows commission stop timestamps after approval', async () => {
        const { referred } = await makeReferralPair({
            referrerOverrides: { referrerCommissionStoppedAt: new Date('2026-01-03T00:00:00.000Z') },
        });

        const result = await evaluate(referred);

        expect(result.eligible).toBe(true);
        expect(result.evaluation.reason).toBe('CREATED');
    });

    it.each([
        ['RATE_ZERO', 0, '100.00'],
        ['ZERO_SOURCE_AMOUNT', 5, '0.00'],
        ['ZERO_AFTER_ROUNDING', 0.01, '0.01'],
    ])('does not create zero-value commissions for %s', async (reason, rate, amountUsd) => {
        const { referred } = await makeReferralPair();
        config.referralCommission.ratePercent = rate;

        const result = await evaluate(referred, amountUsd);

        expect(result.eligible).toBe(false);
        expect(result.evaluation.reason).toBe(reason);
    });
});

describe('referral commission calculation and read queries', () => {
    it.each([
        ['integer rate', 5, '100.00', '5.00'],
        ['decimal rate', 2.5, '10.00', '0.25'],
        ['small amount', 1, '0.99', '0.01'],
        ['large amount', 12.5, '123456789.99', '15432098.75'],
        ['round half up', 33.333, '1.00', '0.33'],
        ['no floating-point drift', 0.3, '0.10', '0.00'],
    ])('calculates %s with decimal.js', async (_name, rate, sourceAmountUsd, expected) => {
        const { referred } = await makeReferralPair();
        config.referralCommission.ratePercent = rate;

        const result = await evaluate(referred, sourceAmountUsd);

        if (expected === '0.00') {
            expect(result.eligible).toBe(false);
            expect(result.evaluation.reason).toBe('ZERO_AFTER_ROUNDING');
        } else {
            expect(result.eligible).toBe(true);
            expect(result.commissionAmountUsd).toBe(expected);
        }
    });

    it('lists commissions and aggregates Decimal-safe totals by status', async () => {
        const { referrer, referred } = await makeReferralPair();
        const base = {
            referrerId: referrer._id,
            referredUserId: referred._id,
            depositId: undefined,
            walletTransactionId: undefined,
            sourceAmount: '100.00',
            sourceCurrency: 'USD',
            sourceExchangeRate: '1',
            sourceAmountUsd: '100.00',
            commissionRatePercent: '5',
            commissionAmountUsd: '5.00',
            commissionCurrency: 'USD',
            availableAt: new Date('2026-01-02T00:00:00.000Z'),
            referredAt: referred.referredAt,
            calculationVersion: 'v1',
            policySource: 'ENV_REFERRAL_COMMISSION',
        };

        await ReferralCommission.create([
            {
                ...base,
                depositId: new User()._id,
                walletTransactionId: new User()._id,
                idempotencyKey: 'deposit:a:referral-commission:v1',
            },
            {
                ...base,
                depositId: new User()._id,
                walletTransactionId: new User()._id,
                commissionAmountUsd: '2.50',
                status: COMMISSION_STATUS.LOCKED,
                idempotencyKey: 'deposit:b:referral-commission:v1',
            },
        ]);

        const list = await commissionService.listCommissionsForReferrer(referrer._id, { limit: 1 });
        const summary = await commissionService.getCommissionSummaryForReferrer(referrer._id);

        expect(list.commissions).toHaveLength(1);
        expect(list.pagination.total).toBe(2);
        expect(summary.count).toBe(2);
        expect(summary.totals.AVAILABLE).toBe('5.00');
        expect(summary.totals.LOCKED).toBe('2.50');
        expect(summary.totals.PAID).toBe('0.00');
        expect(summary.totals.CANCELLED).toBe('0.00');
    });
});
