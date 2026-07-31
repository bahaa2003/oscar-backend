'use strict';

const { validationResult } = require('express-validator');
const { User, USER_STATUS, REFERRAL_SOURCE, ROLES } = require('../modules/users/user.model');
const { registerValidation } = require('../modules/auth/auth.validation');
const { register } = require('../modules/auth/auth.service');
const {
    mapRegistrationReferrerCodeAliases,
    resolveRegistrationReferrer,
    REFERRAL_ATTRIBUTION_REASONS,
} = require('../modules/referrals/referralAttribution.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
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
});

afterEach(() => {
    jest.restoreAllMocks();
});

const uniqueEmail = (prefix = 'rr') =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

const createDefaultGroup = () =>
    createGroup({ name: `Default-${Date.now()}-${Math.random().toString(36).slice(2)}`, percentage: 0, isDefault: true });

const validRegistrationPayload = (overrides = {}) => ({
    name: 'Referral Invitee',
    email: uniqueEmail(),
    password: 'ValidPass@1',
    currency: 'USD',
    ...overrides,
});

const findReferralFields = (userId) =>
    User.findById(userId).select('+referredBy +referredAt +referralSource');

const runRegisterValidation = async (body) => {
    const req = { body };
    await Promise.all(registerValidation.map((validator) => validator.run(req)));
    return validationResult(req).array();
};

describe('registration referrer-code boundary mapping', () => {
    it('uses referrerCode, then invitationCode, then legacy referralCode precedence', () => {
        expect(mapRegistrationReferrerCodeAliases({ referrerCode: ' abcdefghjk ' }).referrerCode)
            .toBe('ABCDEFGHJK');
        expect(mapRegistrationReferrerCodeAliases({ invitationCode: ' bcdefghjkl ' }).referrerCode)
            .toBe('BCDEFGHJKL');
        expect(mapRegistrationReferrerCodeAliases({ referralCode: ' cdefghjklm ' }).referrerCode)
            .toBe('CDEFGHJKLM');
        expect(mapRegistrationReferrerCodeAliases({
            referrerCode: '   ',
            invitationCode: ' defghjklmn ',
        }).referrerCode).toBe('DEFGHJKLMN');
    });

    it('accepts multiple aliases when their normalized values match', () => {
        const mapped = mapRegistrationReferrerCodeAliases({
            referrerCode: ' abcdefghjk ',
            invitationCode: 'abcdefghjk',
            referralCode: 'ABCDEFGHJK',
        });

        expect(mapped.referrerCode).toBe('ABCDEFGHJK');
        expect(mapped.aliases).toEqual(['referrerCode', 'invitationCode', 'referralCode']);
    });

    it('rejects conflicting aliases before registration', () => {
        expect(() => mapRegistrationReferrerCodeAliases({
            referrerCode: 'ABCDEFGHJK',
            invitationCode: 'BCDEFGHJKL',
        })).toThrow(expect.objectContaining({
            code: 'CONFLICTING_REFERRER_CODES',
        }));
    });

    it('validates only a bounded alias length at the DTO layer', async () => {
        const validPayload = validRegistrationPayload({
            referrerCode: 'bad code $$$',
            invitationCode: '',
            referralCode: '',
        });
        const structuralErrors = await runRegisterValidation(validPayload);
        expect(structuralErrors).toEqual([]);

        const lengthErrors = await runRegisterValidation(validRegistrationPayload({
            referrerCode: 'A'.repeat(33),
        }));
        expect(lengthErrors.some((error) => error.path === 'referrerCode')).toBe(true);
    });
});

describe('normal registration referral attribution', () => {
    it('creates a normal registration without attribution when no referrer code is supplied', async () => {
        await createDefaultGroup();

        const result = await register(validRegistrationPayload());
        const invitee = await findReferralFields(result.user._id);

        expect(result.referral).toEqual({
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.NO_REFERRER_CODE,
        });
        expect(invitee.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(invitee.referredBy).toBeNull();
        expect(invitee.referredAt).toBeNull();
        expect(invitee.referralSource).toBeNull();
        expect(result.user.referredBy).toBeUndefined();
        expect(result.user.referredAt).toBeUndefined();
        expect(result.user.referralSource).toBeUndefined();
    });

    it('applies a valid active referrer code without mutating the inviter or financial state', async () => {
        const group = await createDefaultGroup();
        const inviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('inviter'),
            referralCode: 'ABCDEFGHJK',
            walletBalance: 123.45,
        });
        const inviterBefore = await User.findById(inviter._id);
        const walletTransactionsBefore = await WalletTransaction.countDocuments();
        const depositsBefore = await DepositRequest.countDocuments();

        const result = await register(validRegistrationPayload({
            email: uniqueEmail('invitee'),
            referrerCode: ' abcdefghjk ',
        }));

        const invitee = await findReferralFields(result.user._id);
        const freshInviter = await User.findById(inviter._id);

        expect(result.referral).toEqual({
            applied: true,
            reason: REFERRAL_ATTRIBUTION_REASONS.APPLIED,
        });
        expect(invitee.referredBy.toString()).toBe(inviter._id.toString());
        expect(invitee.referredAt).toBeInstanceOf(Date);
        expect(invitee.referralSource).toBe(REFERRAL_SOURCE.EMAIL_REGISTRATION);
        expect(invitee.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(invitee.referralCode).not.toBe(inviter.referralCode);
        expect(result.user.referredBy).toBeUndefined();
        expect(freshInviter.referralCode).toBe(inviterBefore.referralCode);
        expect(freshInviter.walletBalance).toBe(inviterBefore.walletBalance);
        expect(freshInviter.updatedAt.getTime()).toBe(inviterBefore.updatedAt.getTime());
        expect(await WalletTransaction.countDocuments()).toBe(walletTransactionsBefore);
        expect(await DepositRequest.countDocuments()).toBe(depositsBefore);
    });

    it('allows any active user role to refer a normal registration', async () => {
        const group = await createDefaultGroup();
        const adminReferrer = await createAdmin({
            groupId: group._id,
            email: uniqueEmail('admin-referrer'),
            referralCode: 'BCDEFGHJKL',
            role: ROLES.ADMIN,
        });

        const result = await register(validRegistrationPayload({
            email: uniqueEmail('admin-invitee'),
            referrerCode: 'BCDEFGHJKL',
        }));

        const invitee = await findReferralFields(result.user._id);
        expect(invitee.referredBy.toString()).toBe(adminReferrer._id.toString());
        expect(invitee.referralSource).toBe(REFERRAL_SOURCE.EMAIL_REGISTRATION);
    });

    it('allows multiple invitees to use the same valid referrer code', async () => {
        const group = await createDefaultGroup();
        const inviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('multi-inviter'),
            referralCode: 'CDEFGHJKLM',
        });

        const first = await register(validRegistrationPayload({
            email: uniqueEmail('invitee-one'),
            referrerCode: 'CDEFGHJKLM',
        }));
        const second = await register(validRegistrationPayload({
            email: uniqueEmail('invitee-two'),
            referrerCode: 'cdefghjklm',
        }));

        const invitees = await Promise.all([
            findReferralFields(first.user._id),
            findReferralFields(second.user._id),
        ]);

        expect(invitees.map((user) => user.referredBy.toString()))
            .toEqual([inviter._id.toString(), inviter._id.toString()]);
    });

    it.each([
        ['unknown', 'DEFGHJKLMN', REFERRAL_ATTRIBUTION_REASONS.INVALID_REFERRER_CODE],
        ['malformed', 'not a code', REFERRAL_ATTRIBUTION_REASONS.INVALID_REFERRER_CODE],
        ['empty', '   ', REFERRAL_ATTRIBUTION_REASONS.NO_REFERRER_CODE],
    ])('does not block registration for a %s referrer code', async (_caseName, referrerCode, expectedReason) => {
        await createDefaultGroup();

        const result = await register(validRegistrationPayload({ referrerCode }));
        const invitee = await findReferralFields(result.user._id);

        expect(result.referral).toEqual({
            applied: false,
            reason: expectedReason,
        });
        expect(invitee.referredBy).toBeNull();
        expect(invitee.referredAt).toBeNull();
        expect(invitee.referralSource).toBeNull();
    });

    it.each([
        ['inactive', { status: USER_STATUS.PENDING }, REFERRAL_ATTRIBUTION_REASONS.REFERRER_INACTIVE],
        ['deleted', { deletedAt: new Date() }, REFERRAL_ATTRIBUTION_REASONS.INVALID_REFERRER_CODE],
    ])('does not block registration when the referrer is %s', async (_caseName, referrerOverrides, expectedReason) => {
        const group = await createDefaultGroup();
        await createCustomer({
            groupId: group._id,
            email: uniqueEmail('inactive-or-deleted'),
            referralCode: 'EFGHJKLMNP',
            ...referrerOverrides,
        });

        const result = await register(validRegistrationPayload({
            email: uniqueEmail('inactive-invitee'),
            referrerCode: 'EFGHJKLMNP',
        }));
        const invitee = await findReferralFields(result.user._id);

        expect(result.referral).toEqual({
            applied: false,
            reason: expectedReason,
        });
        expect(invitee.referredBy).toBeNull();
        expect(invitee.referredAt).toBeNull();
        expect(invitee.referralSource).toBeNull();
    });

    it('does not apply self-referral and preserves duplicate-email behavior', async () => {
        const group = await createDefaultGroup();
        const inviter = await createCustomer({
            groupId: group._id,
            email: 'self-referrer@test.com',
            referralCode: 'FGHJKLMNPQ',
        });

        const resolved = await resolveRegistrationReferrer({
            referrerCode: 'fghjklmnpq',
            email: ' SELF-REFERRER@test.com ',
        });
        expect(resolved).toMatchObject({
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.SELF_REFERRAL_NOT_APPLIED,
        });

        await expect(register(validRegistrationPayload({
            email: inviter.email,
            referrerCode: inviter.referralCode,
        }))).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(await User.countDocuments({ email: inviter.email })).toBe(1);
    });
});
