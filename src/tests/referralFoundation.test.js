'use strict';

const crypto = require('crypto');
const { User, ROLES, USER_STATUS, RESELLER_STATUS } = require('../modules/users/user.model');
const { register } = require('../modules/auth/auth.service');
const userService = require('../modules/users/user.service');
const adminUsersService = require('../modules/admin/admin.users.service');
const { createUserWithReferralCode } = require('../modules/referrals/referralCode.service');
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

const uniqueEmail = (prefix = 'rf') =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

describe('referral code generation', () => {
    it('creates an email/password user with a generated normalized referral code', async () => {
        await createGroup({ name: 'Default', percentage: 0, isDefault: true });

        const result = await register({
            name: 'Stage User',
            email: uniqueEmail(),
            password: 'ValidPass@1',
        });

        const dbUser = await User.findById(result.user._id);
        expect(dbUser.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(dbUser.resellerStatus).toBe(RESELLER_STATUS.NONE);
        expect(dbUser.role).toBe(ROLES.CUSTOMER);
    });

    it('creates a Google-style new user with a generated referral code', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });

        const user = await createUserWithReferralCode({
            name: 'Google User',
            email: uniqueEmail('google'),
            googleId: `google-${Date.now()}`,
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        }, { User });

        expect(user.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(user.resellerStatus).toBe(RESELLER_STATUS.NONE);
    });

    it('does not accept registration referralCode input as the user own code', async () => {
        await createGroup({ name: 'Default', percentage: 0, isDefault: true });

        const result = await register({
            name: 'Invited User',
            email: uniqueEmail('ignored'),
            password: 'ValidPass@1',
            referralCode: 'USERINPUT1',
        });

        const dbUser = await User.findById(result.user._id);
        expect(dbUser.referralCode).not.toBe('USERINPUT1');
        expect(dbUser.referredBy).toBeUndefined();
    });

    it('keeps referral code stable after profile and group updates', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const otherGroup = await createGroup({ name: 'Other', percentage: 20 });
        const user = await createCustomer({ groupId: group._id });
        const originalCode = user.referralCode;

        await userService.updateMyProfile(user._id, {
            name: 'Renamed',
            referralCode: 'ATTEMPTED1',
        });
        await userService.updateUser(user._id, { groupId: otherGroup._id, referralCode: 'ATTEMPTED2' });

        const fresh = await User.findById(user._id);
        expect(fresh.referralCode).toBe(originalCode);
        expect(fresh.groupId.toString()).toBe(otherGroup._id.toString());
    });

    it('generic admin update cannot change referral or reseller fields', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const admin = await createAdmin({ groupId: group._id });
        const user = await createCustomer({ groupId: group._id });
        const originalCode = user.referralCode;

        await adminUsersService.updateUser(user._id, {
            name: 'Admin Renamed',
            referralCode: 'ADMINCODE1',
            resellerStatus: RESELLER_STATUS.APPROVED,
            referredBy: admin._id,
        }, admin._id);

        const fresh = await User.findById(user._id).select('+referredBy');
        expect(fresh.name).toBe('Admin Renamed');
        expect(fresh.referralCode).toBe(originalCode);
        expect(fresh.resellerStatus).toBe(RESELLER_STATUS.NONE);
        expect(fresh.referredBy).toBeNull();
    });

    it('retries duplicate referral code collisions and then succeeds', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        await createCustomer({ groupId: group._id, referralCode: 'AAAAAAAAAA' });

        jest.spyOn(crypto, 'randomInt')
            .mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
            .mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
            .mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
            .mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
            .mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
            .mockImplementation(() => 1);

        const user = await createUserWithReferralCode({
            name: 'Collision User',
            email: uniqueEmail('collision'),
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        }, { User, maxRetries: 2 });

        expect(user.referralCode).toBe('BBBBBBBBBB');
    });

    it('fails clearly when referral code retry attempts are exhausted', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        await createCustomer({ groupId: group._id, referralCode: 'AAAAAAAAAA' });
        jest.spyOn(crypto, 'randomInt').mockReturnValue(0);

        await expect(createUserWithReferralCode({
            name: 'Exhausted User',
            email: uniqueEmail('exhausted'),
            role: ROLES.CUSTOMER,
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        }, { User, maxRetries: 2 })).rejects.toMatchObject({
            code: 'REFERRAL_CODE_GENERATION_FAILED',
        });
    });

    it('enforces referralCode uniqueness through a database index', async () => {
        await User.syncIndexes();
        const indexes = await User.collection.indexes();
        expect(indexes.some((index) => index.name === 'unique_referral_code' && index.unique)).toBe(true);
    });
});

describe('referral relation and reseller foundation', () => {
    it('defaults relation fields to null and does not create attribution from input', async () => {
        await createGroup({ name: 'Default', percentage: 0, isDefault: true });

        const result = await register({
            name: 'No Attribution',
            email: uniqueEmail('noattr'),
            password: 'ValidPass@1',
            referralCode: 'INVITER123',
        });

        const dbUser = await User.findById(result.user._id).select('+referredBy +referredAt +referralSource');
        expect(dbUser.referredBy).toBeNull();
        expect(dbUser.referredAt).toBeNull();
        expect(dbUser.referralSource).toBeNull();
    });

    it('prevents changing referral relation fields after assignment', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const referrer = await createCustomer({ groupId: group._id });
        const otherReferrer = await createCustomer({ groupId: group._id });
        const user = await createCustomer({
            groupId: group._id,
            referredBy: referrer._id,
            referredAt: new Date(),
            referralSource: 'EMAIL_REGISTRATION',
        });

        const fresh = await User.findById(user._id).select('+referredBy +referredAt +referralSource');
        fresh.referredBy = otherReferrer._id;

        await expect(fresh.save()).rejects.toThrow(/referredBy cannot be changed/);
    });

    it('does not introduce a RESELLER role', () => {
        expect(Object.values(ROLES)).toEqual(['ADMIN', 'SUPERVISOR', 'CUSTOMER']);
        expect(Object.values(ROLES)).not.toContain('RESELLER');
    });
});
