'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../app');
const config = require('../config/config');
const authService = require('../modules/auth/auth.service');
const emailService = require('../services/email.service');
const { verifyGoogleProfile } = require('../config/google.strategy');
const { Currency } = require('../modules/currency/currency.model');
const { User, USER_STATUS, REFERRAL_SOURCE, RESELLER_STATUS } = require('../modules/users/user.model');
const { Product } = require('../modules/products/product.model');
const { Order } = require('../modules/orders/order.model');
const { ReferralCommission, COMMISSION_STATUS } = require('../modules/referrals/referralCommission.model');
const { ReferralPayoutRequest, PAYOUT_METHOD, PAYOUT_STATUS } = require('../modules/referrals/referralPayoutRequest.model');
const commissionService = require('../modules/referrals/referralCommission.service');
const payoutService = require('../modules/referrals/referralPayout.service');
const resellerService = require('../modules/resellerApplications/resellerApplication.service');
const orderService = require('../modules/orders/order.service');
const { WalletTransaction, TRANSACTION_SOURCE_TYPES } = require('../modules/wallet/walletTransaction.model');
const walletService = require('../modules/wallet/wallet.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    createProduct,
} = require('./testHelpers');
const {
    PHASE_4C_CODES,
    runPhase4cBusinessContractPreflight,
} = require('../../scripts/phase4cBusinessContractPreflight');

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

const seedCurrency = (code, platformRate = 1, overrides = {}) => Currency.create({
    code,
    name: `${code} Currency`,
    symbol: code,
    platformRate,
    marketRate: platformRate,
    isActive: true,
    ...overrides,
});

const googleProfile = ({ id = `gid-${Date.now()}-${Math.random()}`, email, name = 'Google User' } = {}) => ({
    id,
    displayName: name,
    emails: [{ value: email || `google-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com` }],
});

const runGoogleVerify = (req, profile) =>
    new Promise((resolve, reject) => {
        verifyGoogleProfile(req, null, null, profile, (err, user) => {
            if (err) return reject(err);
            return resolve(user);
        });
    });

const applicationPayload = (overrides = {}) => ({
    businessName: `Phase4C Shop ${Math.random().toString(36).slice(2)}`,
    businessType: 'STORE',
    country: 'Egypt',
    city: 'Cairo',
    contactPhone: '+201000000000',
    salesChannels: ['ONLINE'],
    expectedMonthlyVolume: '100',
    experienceSummary: 'We need reseller pricing for a verified customer channel.',
    ...overrides,
});

const createCommission = async ({
    referrer,
    invitee,
    amountUsd = '2.00',
    amount = amountUsd,
    currency = 'USD',
    status = COMMISSION_STATUS.AVAILABLE,
} = {}) => ReferralCommission.create({
    referrerId: referrer._id,
    referredUserId: invitee._id,
    depositId: new mongoose.Types.ObjectId(),
    walletTransactionId: new mongoose.Types.ObjectId(),
    sourceAmount: '100.00',
    sourceCurrency: 'USD',
    sourceExchangeRate: '1',
    sourceAmountUsd: '100.00',
    commissionRatePercent: '2',
    commissionAmountUsd: amountUsd,
    commissionAmount: amount,
    referrerCurrency: currency,
    referrerExchangeRateFromUsd: currency === 'USD' ? '1' : '50',
    commissionCurrency: currency,
    status,
    availableAt: new Date('2026-01-02T00:00:00.000Z'),
    referredAt: invitee.referredAt || new Date('2026-01-01T00:00:00.000Z'),
    calculatedAt: new Date('2026-01-02T00:00:00.000Z'),
    eligibilityWindowEndsAt: new Date('2026-01-31T00:00:00.000Z'),
    idempotencyKey: `phase4c:${new mongoose.Types.ObjectId()}`,
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
    jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue();
    config.referralCommission.enabled = true;
    config.referralCommission.ratePercent = 2;
    config.referralPayout.minUsd = '1';
    walletService.__setWalletTestHooks({});
    payoutService.__setReferralPayoutTestHooks({});
    resellerService.__setResellerApplicationTestHooks({});
});

afterEach(() => {
    config.referralCommission.enabled = false;
    config.referralCommission.ratePercent = null;
    config.referralPayout.minUsd = process.env.REFERRAL_PAYOUT_MIN_USD || '1';
    walletService.__setWalletTestHooks({});
    payoutService.__setReferralPayoutTestHooks({});
    resellerService.__setResellerApplicationTestHooks({});
    jest.restoreAllMocks();
});

describe('Phase 4C highest Group and reseller suspension contracts', () => {
    test('email and Google signup use the highest active eligible Group, not isDefault', async () => {
        const defaultGroup = await createGroup({ name: 'Default-Low', percentage: 1, isDefault: true });
        const highestGroup = await createGroup({ name: 'Highest-Normal', percentage: 40 });
        await createGroup({ name: 'Inactive-Higher', percentage: 90, isActive: false });
        await createGroup({ name: 'Deleted-Higher', percentage: 80, deletedAt: new Date() });
        await seedCurrency('USD', 1);

        const registered = await authService.register({
            name: 'Highest Email',
            email: `highest-${Date.now()}@test.com`,
            password: 'SecurePass@1',
            country: 'EG',
            currency: 'USD',
        });
        const dbRegistered = await User.findById(registered.user._id);

        const googleUser = await runGoogleVerify({}, googleProfile());

        expect(String(dbRegistered.groupId)).toBe(String(highestGroup._id));
        expect(String(googleUser.groupId)).toBe(String(highestGroup._id));
        expect(String(dbRegistered.groupId)).not.toBe(String(defaultGroup._id));
        expect(googleUser.country).toBeNull();
        expect(googleUser.currency).toBeNull();
        expect(authService.loginWithGoogle(googleUser).user).toMatchObject({
            profileCompletionRequired: true,
            missingProfileFields: ['country', 'currency'],
        });
    });

    test('referral does not change normal registration Group selection', async () => {
        const lowGroup = await createGroup({ name: 'Default-Low', percentage: 0, isDefault: true });
        const highestGroup = await createGroup({ name: 'Highest', percentage: 25 });
        const referrer = await createCustomer({ groupId: lowGroup._id, status: USER_STATUS.ACTIVE });

        const result = await authService.register({
            name: 'Referred Highest',
            email: `referred-highest-${Date.now()}@test.com`,
            password: 'SecurePass@1',
            country: 'EG',
            currency: 'USD',
            referrerCode: referrer.referralCode,
        });
        const fresh = await User.findById(result.user._id).select('+referredBy +referralSource');

        expect(String(fresh.groupId)).toBe(String(highestGroup._id));
        expect(String(fresh.referredBy)).toBe(String(referrer._id));
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.EMAIL_REGISTRATION);
    });

    test('suspended reseller returns to previous normal Group, then falls back to highest Group when previous is unavailable', async () => {
        const previousGroup = await createGroup({ name: 'Previous-Normal', percentage: 10 });
        const highestGroup = await createGroup({ name: 'Highest-Fallback', percentage: 30 });
        const resellerGroup = await createGroup({ name: 'Reseller-Commercial', percentage: 5 });
        const admin = await createAdmin();

        const customer = await createCustomer({ groupId: previousGroup._id });
        const application = await resellerService.submitApplication(customer._id, applicationPayload());
        const approved = await resellerService.approveApplication(application._id, admin._id, { assignedGroupId: resellerGroup._id });

        await resellerService.suspendApplication(approved._id, admin._id, { suspensionReason: 'Pause reseller pricing.' });
        let fresh = await User.findById(customer._id);
        expect(fresh.resellerStatus).toBe(RESELLER_STATUS.SUSPENDED);
        expect(String(fresh.groupId)).toBe(String(previousGroup._id));
        expect(String(fresh.resellerGroupId)).toBe(String(resellerGroup._id));

        await resellerService.reactivateApplication(approved._id, admin._id, {});
        fresh = await User.findById(customer._id);
        expect(fresh.resellerStatus).toBe(RESELLER_STATUS.APPROVED);
        expect(String(fresh.groupId)).toBe(String(resellerGroup._id));

        await previousGroup.updateOne({ isActive: false });
        const fallbackCustomer = await createCustomer({ groupId: previousGroup._id });
        const fallbackApplication = await resellerService.submitApplication(fallbackCustomer._id, applicationPayload());
        const fallbackApproved = await resellerService.approveApplication(
            fallbackApplication._id,
            admin._id,
            { assignedGroupId: resellerGroup._id }
        );
        await resellerService.suspendApplication(fallbackApproved._id, admin._id, { suspensionReason: 'Fallback required.' });

        const freshFallback = await User.findById(fallbackCustomer._id);
        expect(String(freshFallback.groupId)).toBe(String(highestGroup._id));
    });
});

describe('Phase 4C Google profile completion flow', () => {
    test('incomplete Google user is blocked from app routes until country and currency are completed', async () => {
        await seedCurrency('EGP', 50);
        const group = await createGroup();
        const user = await createCustomer({
            groupId: group._id,
            googleId: `gid-${Date.now()}`,
            password: undefined,
            country: null,
            currency: null,
        });
        const token = tokenFor(user);

        const profile = await api('get', '/me', { token });
        expect(profile.status).toBe(200);
        expect(profile.data.data.profileCompletionRequired).toBe(true);
        expect(profile.data.data.missingProfileFields).toEqual(['country', 'currency']);

        const blocked = await api('get', '/me/products', { token });
        expect(blocked.status).toBe(403);
        expect(blocked.data.code).toBe('PROFILE_COMPLETION_REQUIRED');

        const completed = await api('patch', '/me/profile-completion', {
            token,
            data: { country: 'eg', currency: 'egp' },
        });
        expect(completed.status).toBe(200);
        expect(completed.data.data.user.profileCompletionRequired).toBe(false);

        const allowed = await api('get', '/me/products', { token });
        expect(allowed.status).toBe(200);
    });

    test('incomplete Google user cannot bypass completion through protected business APIs', async () => {
        const group = await createGroup();
        const user = await createCustomer({
            groupId: group._id,
            googleId: `gid-bypass-${Date.now()}`,
            password: undefined,
            country: null,
            currency: null,
        });
        const token = tokenFor(user);

        const requests = [
            ['get', '/me/wallet'],
            ['post', '/me/orders', { productId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
            ['post', '/me/deposits', { requestedAmount: 10, currency: 'USD', paymentMethodId: 'manual' }],
            ['get', '/wallet/stats'],
            ['post', '/orders', { productId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
            ['get', '/orders/my'],
            ['post', '/deposits', { requestedAmount: 10, currency: 'USD', paymentMethodId: 'manual' }],
            ['get', '/deposits'],
            ['get', '/referrals/me/dashboard'],
            ['post', '/referrals/me/payouts', { commissionIds: [new mongoose.Types.ObjectId().toString()], method: 'WALLET' }],
            ['post', '/reseller-applications/me', applicationPayload()],
            ['get', '/me/targets/apps'],
            ['post', '/me/targets', { targetAppId: new mongoose.Types.ObjectId().toString(), targetUrl: 'https://example.com/a' }],
            ['post', '/pricing/me/quote', { items: [{ productId: new mongoose.Types.ObjectId().toString(), quantity: 1 }], currency: 'USD' }],
            ['patch', '/users/me', { name: 'Bypass Attempt' }],
        ];

        for (const [method, path, data] of requests) {
            const response = await api(method, path, { token, data });
            expect(response.status).toBe(403);
            expect(response.data.code).toBe('PROFILE_COMPLETION_REQUIRED');
        }

        const profile = await api('get', '/me', { token });
        expect(profile.status).toBe(200);
        const legacyProfileRead = await api('get', '/users/me', { token });
        expect(legacyProfileRead.status).toBe(200);
    });

    test('trusted OAuth referral is shown as locked and cannot be replaced during completion', async () => {
        await seedCurrency('USD', 1);
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const otherReferrer = await createCustomer({ groupId: group._id });
        const user = await createCustomer({
            groupId: group._id,
            googleId: `gid-${Date.now()}`,
            password: undefined,
            country: null,
            currency: null,
            referredBy: referrer._id,
            referredAt: new Date(),
            referralSource: REFERRAL_SOURCE.GOOGLE_OAUTH,
        });
        const token = tokenFor(user);

        const profile = await api('get', '/me', { token });
        expect(profile.data.data.profileCompletionReferral).toMatchObject({
            code: referrer.referralCode,
            locked: true,
            source: REFERRAL_SOURCE.GOOGLE_OAUTH,
        });

        const replacement = await api('patch', '/me/profile-completion', {
            token,
            data: { country: 'EG', currency: 'USD', referrerCode: otherReferrer.referralCode },
        });
        expect(replacement.status).toBe(422);
        expect(replacement.data.code).toBe('REFERRAL_ALREADY_SET');

        const completed = await api('patch', '/me/profile-completion', {
            token,
            data: { country: 'EG', currency: 'USD', referrerCode: referrer.referralCode },
        });
        expect(completed.status).toBe(200);
        const fresh = await User.findById(user._id).select('+referredBy +referralSource');
        expect(String(fresh.referredBy)).toBe(String(referrer._id));
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.GOOGLE_OAUTH);
    });

    test('OAuth without referral allows one optional referral; existing linked users cannot gain one later', async () => {
        await seedCurrency('USD', 1);
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id });
        const googleUser = await createCustomer({
            groupId: group._id,
            googleId: `gid-${Date.now()}`,
            password: undefined,
            country: null,
            currency: null,
        });

        const applied = await api('patch', '/me/profile-completion', {
            token: tokenFor(googleUser),
            data: { country: 'EG', currency: 'USD', referrerCode: referrer.referralCode },
        });
        expect(applied.status).toBe(200);
        const freshGoogle = await User.findById(googleUser._id).select('+referredBy +referralSource');
        expect(String(freshGoogle.referredBy)).toBe(String(referrer._id));
        expect(freshGoogle.referralSource).toBe(REFERRAL_SOURCE.GOOGLE_OAUTH);

        const linkedEmailUser = await createCustomer({
            groupId: group._id,
            googleId: `linked-${Date.now()}`,
            country: null,
            currency: null,
        });
        const rejected = await api('patch', '/me/profile-completion', {
            token: tokenFor(linkedEmailUser),
            data: { country: 'EG', currency: 'USD', referrerCode: referrer.referralCode },
        });
        expect(rejected.status).toBe(422);
        expect(rejected.data.code).toBe('REFERRAL_COMPLETION_NOT_ALLOWED');
    });
});

describe('Phase 4C referral commission window and currency conversion', () => {
    test('30-day window includes one second before deadline and excludes exact deadline and after', async () => {
        await seedCurrency('EGP', 50);
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'EGP' });
        const referredAt = new Date('2026-01-01T00:00:00.000Z');
        const referredUser = await createCustomer({
            groupId: group._id,
            referredBy: referrer._id,
            referredAt,
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });

        const beforeDeadline = await commissionService.evaluateDepositCommission({
            referredUser,
            approvalTimestamp: new Date('2026-01-30T23:59:59.000Z'),
            sourceAmountUsd: '20.00',
        });
        const atDeadline = await commissionService.evaluateDepositCommission({
            referredUser,
            approvalTimestamp: new Date('2026-01-31T00:00:00.000Z'),
            sourceAmountUsd: '20.00',
        });
        const afterDeadline = await commissionService.evaluateDepositCommission({
            referredUser,
            approvalTimestamp: new Date('2026-01-31T00:00:01.000Z'),
            sourceAmountUsd: '20.00',
        });

        expect(beforeDeadline.eligible).toBe(true);
        expect(beforeDeadline.evaluation.eligibilityWindowEndsAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
        expect(atDeadline.eligible).toBe(false);
        expect(atDeadline.evaluation.reason).toBe('REFERRAL_WINDOW_EXPIRED');
        expect(afterDeadline.eligible).toBe(false);
        expect(afterDeadline.evaluation.reason).toBe('REFERRAL_WINDOW_EXPIRED');
    });

    test('commission calculation stores USD and referrer account-currency snapshots', async () => {
        await seedCurrency('EGP', 50);
        await seedCurrency('SAR', 3.75);
        const group = await createGroup();

        const makeReferred = async (currency) => {
            const referrer = await createCustomer({ groupId: group._id, currency });
            const referredUser = await createCustomer({
                groupId: group._id,
                referredBy: referrer._id,
                referredAt: new Date('2026-01-01T00:00:00.000Z'),
                referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
            });
            return commissionService.evaluateDepositCommission({
                referredUser,
                approvalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
                sourceAmountUsd: '20.00',
            });
        };

        const egp = await makeReferred('EGP');
        const usd = await makeReferred('USD');
        const sar = await makeReferred('SAR');

        expect(egp).toMatchObject({
            eligible: true,
            commissionAmountUsd: '0.40',
            commissionAmount: '20.00',
            commissionCurrency: 'EGP',
            referrerExchangeRateFromUsd: '50',
        });
        expect(usd).toMatchObject({
            eligible: true,
            commissionAmountUsd: '0.40',
            commissionAmount: '0.40',
            commissionCurrency: 'USD',
            referrerExchangeRateFromUsd: '1',
        });
        expect(sar).toMatchObject({
            eligible: true,
            commissionAmountUsd: '0.40',
            commissionAmount: '1.50',
            commissionCurrency: 'SAR',
            referrerExchangeRateFromUsd: '3.75',
        });
    });

    test('destination commission amount uses configured currency precision and ROUND_HALF_UP', async () => {
        await seedCurrency('KWD', 0.154325, { decimalPlaces: 3 });
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'KWD' });
        const referredUser = await createCustomer({
            groupId: group._id,
            referredBy: referrer._id,
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });

        const evaluation = await commissionService.evaluateDepositCommission({
            referredUser,
            approvalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
            sourceAmountUsd: '1000.00',
        });

        expect(evaluation).toMatchObject({
            eligible: true,
            commissionAmountUsd: '20.00',
            commissionAmount: '3.087',
            commissionCurrency: 'KWD',
            referrerExchangeRateFromUsd: '0.154325',
        });

        const deposit = {
            _id: new mongoose.Types.ObjectId(),
            requestedAmount: '50000.00',
            currency: 'EGP',
            exchangeRate: '50',
            amountUsd: '1000.00',
            reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
        };
        const walletTransaction = { _id: new mongoose.Types.ObjectId() };
        const commission = await commissionService.createDepositCommission({
            referrer: evaluation.referrer,
            referredUser,
            deposit,
            walletTransaction,
            evaluation: evaluation.evaluation,
        });

        await Currency.updateOne({ code: 'KWD' }, { $set: { decimalPlaces: 2 } });
        const fresh = await ReferralCommission.findById(commission._id).lean();
        expect(fresh.commissionAmountUsd).toBe('20.00');
        expect(fresh.commissionAmount).toBe('3.087');
        expect(fresh.commissionCurrency).toBe('KWD');
    });

    test('missing or inactive referrer currency fails safely during commission evaluation', async () => {
        await seedCurrency('SAR', 3.75, { isActive: false });
        const group = await createGroup();

        const makeReferred = async (currency) => {
            const referrer = await createCustomer({ groupId: group._id, currency });
            return createCustomer({
                groupId: group._id,
                referredBy: referrer._id,
                referredAt: new Date('2026-01-01T00:00:00.000Z'),
                referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
            });
        };

        await expect(commissionService.evaluateDepositCommission({
            referredUser: await makeReferred('ZZZ'),
            approvalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
            sourceAmountUsd: '20.00',
        })).rejects.toMatchObject({ statusCode: 404 });

        await expect(commissionService.evaluateDepositCommission({
            referredUser: await makeReferred('SAR'),
            approvalTimestamp: new Date('2026-01-02T00:00:00.000Z'),
            sourceAmountUsd: '20.00',
        })).rejects.toMatchObject({ code: 'CURRENCY_INACTIVE' });
    });

    test('existing commission remains immutable after referral window and rate changes', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'USD' });
        const invitee = await createCustomer({
            groupId: group._id,
            referredBy: referrer._id,
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });
        const commission = await createCommission({
            referrer,
            invitee,
            amountUsd: '0.40',
            amount: '0.40',
            currency: 'USD',
        });

        config.referralCommission.ratePercent = 20;
        await User.findByIdAndUpdate(referrer._id, { currency: 'EGP' });

        const fresh = await ReferralCommission.findById(commission._id).lean();
        expect(fresh.status).toBe(COMMISSION_STATUS.AVAILABLE);
        expect(fresh.commissionAmountUsd).toBe('0.40');
        expect(fresh.commissionAmount).toBe('0.40');
        expect(fresh.commissionCurrency).toBe('USD');
    });
});

describe('Phase 4C currency-aware payouts and Decimal precision', () => {
    test('payout payable amount rounds with the stored payout currency precision', async () => {
        await seedCurrency('KWD', 0.154325, { decimalPlaces: 3 });
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'KWD' });
        const invitee = await createCustomer({ groupId: group._id, referredBy: referrer._id, referredAt: new Date() });
        const commission = await createCommission({
            referrer,
            invitee,
            amountUsd: '10.00',
            amount: '1.2345',
            currency: 'KWD',
        });

        const payout = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [commission._id],
            method: PAYOUT_METHOD.MANUAL,
        });

        expect(payout.amountUsd).toBe('10.00');
        expect(payout.amount).toBe('1.235');
        expect(payout.currency).toBe('KWD');
        expect(payout.requestSnapshot.amount).toBe('1.235');
    });

    test('same-currency payouts store payable amount/currency and WALLET settlement credits once in that currency', async () => {
        await seedCurrency('EGP', 50);
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 0 });
        const invitee = await createCustomer({ groupId: group._id, referredBy: referrer._id, referredAt: new Date() });
        const admin = await createAdmin({ groupId: group._id });
        const c1 = await createCommission({ referrer, invitee, amountUsd: '2.00', amount: '100.00', currency: 'EGP' });
        const c2 = await createCommission({ referrer, invitee, amountUsd: '1.00', amount: '50.00', currency: 'EGP' });

        const payout = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [c1._id, c2._id],
            method: PAYOUT_METHOD.WALLET,
        });
        expect(payout.amountUsd).toBe('3.00');
        expect(payout.amount).toBe('150.00');
        expect(payout.currency).toBe('EGP');

        const settled = await payoutService.settlePayout(payout._id, admin._id);
        await payoutService.settlePayout(payout._id, admin._id);

        expect(settled.status).toBe(PAYOUT_STATUS.PAID);
        expect((await User.findById(referrer._id)).walletBalance).toBe(150);
        const ledgers = await WalletTransaction.find({
            userId: referrer._id,
            sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
            sourceId: payout._id,
        });
        expect(ledgers).toHaveLength(1);
        expect(ledgers[0].amount).toBe(150);
    });

    test('mixed payout currencies are rejected and MANUAL settlement stores amount/currency without wallet credit', async () => {
        const group = await createGroup();
        const referrer = await createCustomer({ groupId: group._id, currency: 'USD', walletBalance: 10 });
        const invitee = await createCustomer({ groupId: group._id, referredBy: referrer._id, referredAt: new Date() });
        const admin = await createAdmin({ groupId: group._id });
        const usd = await createCommission({ referrer, invitee, amountUsd: '2.00', amount: '2.00', currency: 'USD' });
        const egp = await createCommission({ referrer, invitee, amountUsd: '2.00', amount: '100.00', currency: 'EGP' });

        await expect(payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [usd._id, egp._id],
            method: PAYOUT_METHOD.WALLET,
        })).rejects.toMatchObject({ code: 'MIXED_PAYOUT_CURRENCIES' });

        const manual = await payoutService.createPayoutRequest(referrer._id, {
            commissionIds: [usd._id],
            method: PAYOUT_METHOD.MANUAL,
        });
        await payoutService.settlePayout(manual._id, admin._id, { externalReference: 'MANUAL-P4C-1' });

        const freshPayout = await ReferralPayoutRequest.findById(manual._id).lean();
        expect(freshPayout.amount).toBe('2.00');
        expect(freshPayout.currency).toBe('USD');
        expect((await User.findById(referrer._id)).walletBalance).toBe(10);
        expect(await WalletTransaction.countDocuments({ sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT })).toBe(0);
    });

    test('high-precision product price survives pricing calculation and immutable order snapshot as a string', async () => {
        const exactPrice = '0.00012387653234454332';
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 100, currency: 'USD' });
        const product = await createProduct({ basePrice: exactPrice, minQty: 1, maxQty: 200000 });

        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 100000,
            idempotencyKey: `phase4c-high-precision-${Date.now()}`,
        });
        const freshOrder = await Order.findById(order._id).lean();
        const freshProduct = await Product.findById(product._id).lean();

        expect(typeof freshProduct.basePrice).toBe('string');
        expect(freshProduct.basePrice).toBe(exactPrice);
        expect(freshOrder.basePriceSnapshot).toBe(exactPrice);
        expect(freshOrder.pricingSnapshot.items[0].baseUnitPrice).toBe(exactPrice);
        expect(freshOrder.pricingSnapshot.items[0].finalUnitPrice).toBe(exactPrice);
        expect(typeof freshOrder.pricingSnapshot.items[0].finalUnitPrice).toBe('string');
    });
});

describe('Phase 4C corrective preflight', () => {
    test('requires explicit --check flag before inspecting data', async () => {
        await expect(runPhase4cBusinessContractPreflight({ check: false }))
            .rejects.toThrow('requires --check');
    });

    test('returns read-only aggregate classifications without PII', async () => {
        await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const result = await runPhase4cBusinessContractPreflight({ check: true, connection: mongoose.connection });
        expect(result.mode).toBe('CHECK_ONLY');
        expect(result.note).toContain('Read-only');
        expect(result.results.map((item) => item.code)).toEqual(expect.arrayContaining([
            PHASE_4C_CODES.USERS_MISSING_COUNTRY,
            PHASE_4C_CODES.USD_ONLY_LEGACY_COMMISSIONS,
            PHASE_4C_CODES.HIGH_PRECISION_PRICE_STORED_AS_NUMBER,
        ]));
        expect(JSON.stringify(result)).not.toContain('@test.com');
    });
});
