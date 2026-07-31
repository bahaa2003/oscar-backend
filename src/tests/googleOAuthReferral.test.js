'use strict';

const { User, USER_STATUS, REFERRAL_SOURCE } = require('../modules/users/user.model');
const { verifyGoogleProfile } = require('../config/google.strategy');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
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
});

afterEach(() => {
    jest.restoreAllMocks();
});

const uniqueEmail = (prefix = 'google-oauth') =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

const createDefaultGroup = () =>
    createGroup({
        name: `GoogleDefault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        percentage: 0,
        isDefault: true,
    });

const googleProfile = ({ id = `gid-${Date.now()}-${Math.random()}`, email, name = 'Google User' } = {}) => ({
    id,
    displayName: name,
    emails: [{ value: email || uniqueEmail() }],
});

const runGoogleVerify = (req, profile) =>
    new Promise((resolve, reject) => {
        verifyGoogleProfile(req, null, null, profile, (err, user) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(user);
        });
    });

const findReferralFields = (userId) =>
    User.findById(userId).select('+referredBy +referredAt +referralSource');

describe('Google OAuth referral attribution', () => {
    it('applies a valid referrer only when Google creates a genuinely new user', async () => {
        const group = await createDefaultGroup();
        const inviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('inviter'),
            referralCode: 'ABCDEFGHJK',
            walletBalance: 321,
        });

        const beforeWalletTransactions = await WalletTransaction.countDocuments();
        const beforeDeposits = await DepositRequest.countDocuments();
        const user = await runGoogleVerify(
            { googleOAuthContext: { referrerCode: 'ABCDEFGHJK' } },
            googleProfile({ email: uniqueEmail('new-google') })
        );
        const fresh = await findReferralFields(user._id);
        const inviterAfter = await User.findById(inviter._id).select('+referredBy +referredAt +referralSource');

        expect(fresh.referredBy.toString()).toBe(inviter._id.toString());
        expect(fresh.referredAt).toBeInstanceOf(Date);
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.GOOGLE_OAUTH);
        expect(fresh.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(fresh.referralCode).not.toBe('ABCDEFGHJK');
        expect(inviterAfter.walletBalance.toString()).toBe('321');
        expect(inviterAfter.referredBy).toBeNull();
        expect(await WalletTransaction.countDocuments()).toBe(beforeWalletTransactions);
        expect(await DepositRequest.countDocuments()).toBe(beforeDeposits);
    });

    it('creates new Google users without attribution for unknown, inactive, deleted, or self referrers', async () => {
        const group = await createDefaultGroup();
        const inactiveInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('inactive'),
            referralCode: 'BCDEFGHJKL',
            status: USER_STATUS.REJECTED,
        });
        const deletedInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('deleted'),
            referralCode: 'CDEFGHJKLM',
            deletedAt: new Date(),
        });

        const cases = [
            ['unknown', 'ZZZZZZZZZZ', uniqueEmail('unknown')],
            ['inactive', inactiveInviter.referralCode, uniqueEmail('inactive-invitee')],
            ['deleted', deletedInviter.referralCode, uniqueEmail('deleted-invitee')],
            ['self', 'DEFGHJKLMN', 'self-google@test.com'],
        ];

        await createCustomer({
            groupId: group._id,
            email: 'self-google@test.com',
            referralCode: 'DEFGHJKLMN',
        });

        for (const [label, referrerCode, email] of cases) {
            const user = await runGoogleVerify(
                { googleOAuthContext: { referrerCode } },
                googleProfile({ id: `gid-${label}-${Date.now()}`, email })
            );
            const fresh = await findReferralFields(user._id);

            expect(fresh.referredBy).toBeNull();
            expect(fresh.referredAt).toBeNull();
            expect(fresh.referralSource).toBeNull();
        }
    });

    it('ignores referral for existing Google users and preserves existing referral fields', async () => {
        const group = await createDefaultGroup();
        const originalInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('original-inviter'),
            referralCode: 'ABCDEFGHJK',
        });
        const newInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('new-inviter'),
            referralCode: 'BCDEFGHJKL',
        });
        const existing = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('existing-google'),
            googleId: 'google-existing-1',
            referredBy: originalInviter._id,
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });

        const user = await runGoogleVerify(
            { googleOAuthContext: { referrerCode: newInviter.referralCode } },
            googleProfile({ id: 'google-existing-1', email: existing.email })
        );
        const fresh = await findReferralFields(user._id);

        expect(fresh._id.toString()).toBe(existing._id.toString());
        expect(fresh.referredBy.toString()).toBe(originalInviter._id.toString());
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.EMAIL_REGISTRATION);
    });

    it('links existing email users without applying or changing referral attribution', async () => {
        const group = await createDefaultGroup();
        const originalInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('original-link-inviter'),
            referralCode: 'ABCDEFGHJK',
        });
        const newInviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('new-link-inviter'),
            referralCode: 'BCDEFGHJKL',
        });
        const existing = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('existing-email-link'),
            googleId: undefined,
            verified: false,
            referredBy: originalInviter._id,
            referredAt: new Date('2026-01-01T00:00:00.000Z'),
            referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
        });

        const user = await runGoogleVerify(
            { googleOAuthContext: { referrerCode: newInviter.referralCode } },
            googleProfile({ id: 'linked-google-id-1', email: existing.email })
        );
        const fresh = await findReferralFields(user._id);

        expect(fresh._id.toString()).toBe(existing._id.toString());
        expect(fresh.googleId).toBe('linked-google-id-1');
        expect(fresh.verified).toBe(true);
        expect(fresh.referredBy.toString()).toBe(originalInviter._id.toString());
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.EMAIL_REGISTRATION);
    });
});
