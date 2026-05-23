'use strict';

/**
 * auth.test.js — Authentication Flow Test Suite
 *
 * Covers:
 *  [1] Registration — token creation, verification email fire-and-forget
 *  [2] Email Verification — happy path, expired token, invalid token
 *  [3] Resend Verification — anti-enumeration, already-verified guard
 *  [4] Login gates — unverified, pending, rejected, Google-only account
 *  [5] Login success — JWT issued, audit logged
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const { User, USER_STATUS } = require('../modules/users/user.model');
const {
    register,
    login,
    verifyEmail,
    resendVerification,
    generate2FASecret,
    enable2FA,
    verify2FA,
} = require('../modules/auth/auth.service');
const emailService = require('../services/email.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
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

/** Create a group + register a new user, return { user, rawToken }. */
const registerUser = async () => {
    await createGroup({ name: 'Default', percentage: 0 });
    const result = await register({
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        password: 'SecurePass@1',
    });
    // Fetch the hashed token from DB
    const dbUser = await User
        .findOne({ email: result.user.email })
        .select('+emailVerificationToken +emailVerificationExpires +verified');

    // Reconstruct the raw token is impossible — instead, use a known raw token.
    // We re-generate by directly seeding: pick a known raw token and hash it.
    const known = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(known).digest('hex');
    dbUser.emailVerificationToken = hash;
    dbUser.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await dbUser.save();

    return { user: dbUser, rawToken: known };
};

// ─────────────────────────────────────────────────────────────────────────────
// [1] Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] Registration', () => {
    beforeEach(async () => {
        await createGroup({ name: 'Default', percentage: 0 });
    });

    it('creates a new user with verified=false and ACTIVE status', async () => {
        const { user } = await register({
            name: 'Alice',
            email: `alice-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationToken +emailVerificationExpires +verified');

        expect(dbUser.verified).toBe(false);
        expect(dbUser.status).toBe(USER_STATUS.ACTIVE);
        expect(dbUser.emailVerificationToken).not.toBeNull();
        expect(dbUser.emailVerificationExpires).not.toBeNull();
    });

    it('stores a HASHED token (not raw) in the DB', async () => {
        const { user } = await register({
            name: 'Bob',
            email: `bob-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationToken');

        // Should be a 64-char hex string (SHA-256)
        expect(dbUser.emailVerificationToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sets expiry ~24 hours in the future', async () => {
        const before = Date.now();
        const { user } = await register({
            name: 'Charlie',
            email: `charlie-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationExpires');

        const expiresMs = dbUser.emailVerificationExpires.getTime();
        const after = Date.now();

        // Should be within [before + 23h, before + 25h] to be flexible
        expect(expiresMs).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
        expect(expiresMs).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);
    });

    it('throws ConflictError if email already registered', async () => {
        const email = `dup-${Date.now()}@example.com`;
        await register({ name: 'D1', email, password: 'SecurePass@1' });
        await expect(
            register({ name: 'D2', email, password: 'AnotherPass@1' })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('does NOT return a JWT token at registration', async () => {
        const result = await register({
            name: 'Eve',
            email: `eve-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });
        expect(result.token).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] Email Verification
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] Email Verification', () => {
    it('marks user as verified and clears token on valid token', async () => {
        const { user, rawToken } = await registerUser();
        expect(user.verified).toBe(false);

        await verifyEmail(rawToken);

        const updated = await User.findById(user._id)
            .select('+emailVerificationToken +emailVerificationExpires +verified');

        expect(updated.verified).toBe(true);
        expect(updated.emailVerificationToken).toBeNull();
        expect(updated.emailVerificationExpires).toBeNull();
    });

    it('returns a redirectUrl', async () => {
        const { rawToken } = await registerUser();
        const { redirectUrl } = await verifyEmail(rawToken);
        expect(typeof redirectUrl).toBe('string');
        expect(redirectUrl.length).toBeGreaterThan(0);
    });

    it('throws on invalid token', async () => {
        await registerUser();
        await expect(
            verifyEmail('completely-wrong-token-that-doesnt-match-anything')
        ).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws on expired token', async () => {
        const { user, rawToken } = await registerUser();

        // Back-date the expiry
        await User.findByIdAndUpdate(user._id, {
            emailVerificationExpires: new Date(Date.now() - 1000),
        });

        await expect(verifyEmail(rawToken))
            .rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws if token already consumed (used twice)', async () => {
        const { rawToken } = await registerUser();
        await verifyEmail(rawToken);   // first use — clears token

        await expect(verifyEmail(rawToken))
            .rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws if no token supplied', async () => {
        await expect(verifyEmail(undefined))
            .rejects.toMatchObject({ code: 'MISSING_TOKEN' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] Resend Verification
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] Resend Verification', () => {
    it('re-issues a new token (different from the old one)', async () => {
        const { user, rawToken: _old } = await registerUser();

        const oldHash = (await User.findById(user._id)
            .select('+emailVerificationToken')).emailVerificationToken;

        await resendVerification(user.email);

        const newHash = (await User.findById(user._id)
            .select('+emailVerificationToken')).emailVerificationToken;

        expect(newHash).not.toEqual(oldHash);
        expect(newHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns an anti-enumeration message for unknown email', async () => {
        const result = await resendVerification('nobody@nowhere.com');
        expect(result.message).toMatch(/verification link has been sent/i);
    });

    it('throws ALREADY_VERIFIED for already-verified user', async () => {
        const group = await createGroup({ name: 'VG', percentage: 0 });
        const user = await createCustomer({   // createCustomer sets verified:true by default
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
        });
        await expect(resendVerification(user.email))
            .rejects.toMatchObject({ code: 'ALREADY_VERIFIED' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] Login Gates
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] Login gates', () => {
    const email = `gates-${Date.now()}@example.com`;
    const password = 'SecurePass@1';

    beforeEach(async () => {
        await createGroup({ name: 'Default', percentage: 0 });
    });

    it('blocks login when email is not verified (even though ACTIVE)', async () => {
        await register({ name: 'Unverified', email, password });
        // Don't verify — status is ACTIVE but verified=false

        await expect(login({ email, password }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email, password }).catch((e) => e);
        expect(err.message).toMatch(/verify your email/i);
    });

    it('blocks login when account is PENDING (even if verified)', async () => {
        // Registration now creates ACTIVE users, so we must explicitly
        // create a PENDING user to test this gate.
        const group = await require('../modules/groups/group.model').findOne({});
        const u = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
            email: `pending-${Date.now()}@example.com`,
            password,
            verified: true,
        });

        await expect(login({ email: u.email, password }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email: u.email, password }).catch((e) => e);
        expect(err.message).toMatch(/awaiting admin approval/i);
    });

    it('blocks login when account is REJECTED', async () => {
        const group = await createGroup({ name: 'RejGrp', percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
            verified: true,
            email: `rejected-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        await expect(login({ email: user.email, password: 'SecurePass@1' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email: user.email, password: 'SecurePass@1' }).catch((e) => e);
        expect(err.message).toMatch(/rejected/i);
    });

    it('blocks password login for Google-only accounts', async () => {
        const group = await createGroup({ name: 'GoogleGrp', percentage: 0 });
        await User.create({
            name: 'Google User',
            email: `goauth-${Date.now()}@example.com`,
            googleId: 'google-uid-123',
            role: 'CUSTOMER',
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            // No password field
        });
        const u = await User.findOne({ googleId: 'google-uid-123' });

        await expect(login({ email: u.email, password: 'any-pass' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] Login Success
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Login success', () => {
    it('issues a JWT when verified + ACTIVE + correct password', async () => {
        const group = await createGroup({ name: 'Success', percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        });

        // Re-set password via the model's pre-save hook
        const raw = 'ThePassword@1';
        const fresh = await User.findById(user._id);
        fresh.password = raw;
        await fresh.save();

        const result = await login({ email: user.email, password: raw });
        expect(result.token).toBeDefined();
        expect(typeof result.token).toBe('string');
        expect(result.token.split('.')).toHaveLength(3);   // JWT has 3 parts
        expect(result.user.password).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [6] Email OTP 2FA
// ─────────────────────────────────────────────────────────────────────────────

describe('[6] Email OTP 2FA', () => {
    const password = 'ThePassword@1';

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const createVerifiedUserWithPassword = async () => {
        const group = await createGroup({ name: `TwoFactor-${Date.now()}`, percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        });

        const fresh = await User.findById(user._id);
        fresh.password = password;
        await fresh.save();

        return fresh;
    };

    const requestAndConfirmSetup = async (user) => {
        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        await generate2FASecret(user._id);
        const plainOtp = sendSpy.mock.calls[0][1];
        await enable2FA(user._id, plainOtp);
        sendSpy.mockRestore();

        return plainOtp;
    };

    it('requests a setup email OTP without enabling 2FA immediately', async () => {
        const user = await createVerifiedUserWithPassword();
        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        const before = Date.now();
        const result = await generate2FASecret(user._id);
        const after = Date.now();

        expect(result.message).toMatch(/verification code sent/i);
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const plainOtp = sendSpy.mock.calls[0][1];
        expect(plainOtp).toMatch(/^\d{6}$/);

        const updated = await User.findById(user._id)
            .select('+twoFactorOtp +twoFactorOtpExpires');
        expect(updated.isTwoFactorEnabled).toBe(false);
        expect(updated.twoFactorOtp).toMatch(/^[a-f0-9]{64}$/);
        expect(updated.twoFactorOtp).not.toBe(plainOtp);
        expect(updated.twoFactorOtpExpires.getTime())
            .toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
        expect(updated.twoFactorOtpExpires.getTime())
            .toBeLessThanOrEqual(after + 5 * 60 * 1000);
    });

    it('confirms setup OTP before enabling 2FA and clears setup OTP fields', async () => {
        const user = await createVerifiedUserWithPassword();
        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        await generate2FASecret(user._id);
        const plainOtp = sendSpy.mock.calls[0][1];

        const result = await enable2FA(user._id, plainOtp);

        const updated = await User.findById(user._id)
            .select('+twoFactorOtp +twoFactorOtpExpires');
        expect(result.message).toMatch(/successfully enabled/i);
        expect(updated.isTwoFactorEnabled).toBe(true);
        expect(updated.twoFactorOtp).toBeNull();
        expect(updated.twoFactorOtpExpires).toBeNull();
    });

    it('rejects an invalid setup OTP and keeps 2FA disabled', async () => {
        const user = await createVerifiedUserWithPassword();
        jest.spyOn(emailService, 'sendTwoFactorOtpEmail').mockResolvedValue();

        await generate2FASecret(user._id);

        await expect(enable2FA(user._id, '000000'))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const updated = await User.findById(user._id);
        expect(updated.isTwoFactorEnabled).toBe(false);
    });

    it('login sends an email OTP, stores only its hash, and returns a temp token', async () => {
        const user = await createVerifiedUserWithPassword();
        await requestAndConfirmSetup(user);

        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        const before = Date.now();
        const result = await login({ email: user.email, password });
        const after = Date.now();

        expect(result.requires2FA).toBe(true);
        expect(result.tempToken).toBeDefined();
        expect(result.email).toBe(user.email);
        expect(result.token).toBeUndefined();
        expect(result.user).toBeUndefined();

        expect(sendSpy).toHaveBeenCalledTimes(1);
        const plainOtp = sendSpy.mock.calls[0][1];
        expect(plainOtp).toMatch(/^\d{6}$/);

        const dbUser = await User.findById(user._id)
            .select('+twoFactorOtp +twoFactorOtpExpires');

        expect(dbUser.twoFactorOtp).toMatch(/^[a-f0-9]{64}$/);
        expect(dbUser.twoFactorOtp).not.toBe(plainOtp);
        expect(dbUser.twoFactorOtpExpires.getTime())
            .toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
        expect(dbUser.twoFactorOtpExpires.getTime())
            .toBeLessThanOrEqual(after + 5 * 60 * 1000);
    });

    it('verify2FA consumes a valid email OTP and returns a full JWT', async () => {
        const user = await createVerifiedUserWithPassword();
        await requestAndConfirmSetup(user);

        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        const challenge = await login({ email: user.email, password });
        const plainOtp = sendSpy.mock.calls[0][1];

        const result = await verify2FA(challenge.tempToken, plainOtp);

        expect(result.token).toBeDefined();
        expect(result.token.split('.')).toHaveLength(3);
        expect(result.user.email).toBe(user.email);

        const dbUser = await User.findById(user._id)
            .select('+twoFactorOtp +twoFactorOtpExpires');

        expect(dbUser.twoFactorOtp).toBeNull();
        expect(dbUser.twoFactorOtpExpires).toBeNull();
    });

    it('verify2FA rejects an expired email OTP and clears it', async () => {
        const user = await createVerifiedUserWithPassword();
        await requestAndConfirmSetup(user);

        const sendSpy = jest
            .spyOn(emailService, 'sendTwoFactorOtpEmail')
            .mockResolvedValue();

        const challenge = await login({ email: user.email, password });
        const plainOtp = sendSpy.mock.calls[0][1];

        await User.findByIdAndUpdate(user._id, {
            twoFactorOtpExpires: new Date(Date.now() - 1000),
        });

        await expect(verify2FA(challenge.tempToken, plainOtp))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const dbUser = await User.findById(user._id)
            .select('+twoFactorOtp +twoFactorOtpExpires');

        expect(dbUser.twoFactorOtp).toBeNull();
        expect(dbUser.twoFactorOtpExpires).toBeNull();
    });
});
