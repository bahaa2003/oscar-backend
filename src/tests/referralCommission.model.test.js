'use strict';

const mongoose = require('mongoose');
const {
    ReferralCommission,
    COMMISSION_STATUS,
    COMMISSION_CURRENCY,
} = require('../modules/referrals/referralCommission.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const objectId = () => new mongoose.Types.ObjectId();

const makeCommissionDoc = (overrides = {}) => ({
    referrerId: objectId(),
    referredUserId: objectId(),
    depositId: objectId(),
    walletTransactionId: objectId(),
    sourceAmount: '100.00',
    sourceCurrency: 'USD',
    sourceExchangeRate: '1',
    sourceAmountUsd: '100.00',
    commissionRatePercent: '5',
    commissionAmountUsd: '5.00',
    commissionCurrency: COMMISSION_CURRENCY,
    availableAt: new Date('2026-01-01T00:00:00.000Z'),
    referralSource: 'EMAIL_REGISTRATION',
    referredAt: new Date('2025-12-01T00:00:00.000Z'),
    idempotencyKey: `deposit:${objectId()}:referral-commission:v1`,
    ...overrides,
});

describe('ReferralCommission model', () => {
    it('requires the financial source, referral, snapshot, and idempotency fields', async () => {
        const commission = new ReferralCommission({});

        await expect(commission.validate()).rejects.toMatchObject({
            errors: expect.objectContaining({
                referrerId: expect.any(Object),
                referredUserId: expect.any(Object),
                depositId: expect.any(Object),
                walletTransactionId: expect.any(Object),
                sourceAmount: expect.any(Object),
                sourceCurrency: expect.any(Object),
                sourceExchangeRate: expect.any(Object),
                sourceAmountUsd: expect.any(Object),
                commissionRatePercent: expect.any(Object),
                commissionAmountUsd: expect.any(Object),
                availableAt: expect.any(Object),
                referredAt: expect.any(Object),
                idempotencyKey: expect.any(Object),
            }),
        });
    });

    it('defaults new commissions to AVAILABLE and keeps future statuses in the enum', async () => {
        const commission = await ReferralCommission.create(makeCommissionDoc());

        expect(commission.status).toBe(COMMISSION_STATUS.AVAILABLE);
        expect(Object.values(COMMISSION_STATUS)).toEqual(
            expect.arrayContaining(['AVAILABLE', 'LOCKED', 'PAID', 'CANCELLED'])
        );
        expect(commission.lockedAt).toBeNull();
        expect(commission.paidAt).toBeNull();
        expect(commission.cancelledAt).toBeNull();
    });

    it('stores money snapshots as decimal strings rather than floating-point fields', async () => {
        const commission = await ReferralCommission.create(makeCommissionDoc({
            sourceAmount: '10.00',
            sourceAmountUsd: '10.00',
            commissionRatePercent: '2.5',
            commissionAmountUsd: '0.25',
        }));

        expect(typeof commission.sourceAmount).toBe('string');
        expect(typeof commission.sourceAmountUsd).toBe('string');
        expect(typeof commission.commissionRatePercent).toBe('string');
        expect(typeof commission.commissionAmountUsd).toBe('string');
        expect(commission.commissionAmountUsd).toBe('0.25');
    });

    it('defines unique deposit and idempotency indexes', () => {
        const indexes = ReferralCommission.schema.indexes();

        expect(indexes).toEqual(expect.arrayContaining([
            [
                { depositId: 1 },
                expect.objectContaining({
                    unique: true,
                    name: 'unique_referral_commission_per_deposit',
                }),
            ],
            [
                { idempotencyKey: 1 },
                expect.objectContaining({
                    unique: true,
                    name: 'unique_referral_commission_idempotency_key',
                }),
            ],
        ]));
    });

    it('rejects duplicate commissions for the same deposit and duplicate idempotency keys', async () => {
        const depositId = objectId();
        const idempotencyKey = `deposit:${depositId}:referral-commission:v1`;

        await ReferralCommission.create(makeCommissionDoc({ depositId, idempotencyKey }));

        await expect(ReferralCommission.create(makeCommissionDoc({
            depositId,
            idempotencyKey: `deposit:${objectId()}:referral-commission:v1`,
        }))).rejects.toMatchObject({ code: 11000 });

        await expect(ReferralCommission.create(makeCommissionDoc({
            depositId: objectId(),
            idempotencyKey,
        }))).rejects.toMatchObject({ code: 11000 });
    });
});
