'use strict';

const mongoose = require('mongoose');
const authController = require('../modules/auth/auth.controller');
const authService = require('../modules/auth/auth.service');
const GoogleOAuthLoginCode = require('../modules/auth/googleOAuthLoginCode.model');
const {
    createGoogleOAuthLoginCode,
    consumeGoogleOAuthLoginCode,
    derivePkceS256Challenge,
    INVALID_OR_EXPIRED_OAUTH_CODE,
} = require('../modules/auth/googleOAuthLoginCode.service');
const { hashOAuthValue } = require('../modules/auth/googleOAuthState.token');
const { User, USER_STATUS, REFERRAL_SOURCE } = require('../modules/users/user.model');
const { verifyGoogleProfile } = require('../config/google.strategy');
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

const PKCE_VERIFIER = 'A'.repeat(43);
const OTHER_PKCE_VERIFIER = 'B'.repeat(43);

const uniqueEmail = (prefix = 'google-handoff') =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

const createDefaultGroup = () =>
    createGroup({
        name: `GoogleHandoffDefault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        percentage: 0,
        isDefault: true,
    });

const createGoogleUser = async (overrides = {}) => {
    const group = overrides.groupId ? null : await createDefaultGroup();
    return createCustomer({
        groupId: overrides.groupId || group._id,
        email: uniqueEmail(),
        googleId: `gid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: USER_STATUS.ACTIVE,
        verified: true,
        ...overrides,
    });
};

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

const callController = async (handler, req, res, next = jest.fn()) => {
    handler(req, res, next);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (res.redirect?.mock?.calls?.length || next.mock.calls.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return next;
};

describe('Google OAuth one-time handoff codes', () => {
    it('stores only a hashed opaque code with PKCE metadata and TTL indexes', async () => {
        const user = await createGoogleUser();
        const codeChallenge = derivePkceS256Challenge(PKCE_VERIFIER);

        const handoff = await createGoogleOAuthLoginCode({
            userId: user._id,
            codeChallenge,
            codeChallengeMethod: 'S256',
            oauthStateId: new mongoose.Types.ObjectId(),
            now: () => 1000,
        });

        expect(handoff.rawCode).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const persisted = await GoogleOAuthLoginCode.findById(handoff.codeId);
        expect(persisted.codeHash).toBe(hashOAuthValue(handoff.rawCode));
        expect(persisted.codeHash).not.toBe(handoff.rawCode);
        expect(persisted.codeChallenge).toBe(codeChallenge);
        expect(persisted.codeChallengeMethod).toBe('S256');
        expect(persisted.toObject().token).toBeUndefined();
        expect(persisted.expiresAt.getTime()).toBeGreaterThan(1000);

        const indexes = GoogleOAuthLoginCode.schema.indexes();
        expect(indexes.some(([fields, options]) =>
            fields.codeHash === 1 && options.unique === true
        )).toBe(true);
        expect(indexes.some(([fields, options]) =>
            fields.expiresAt === 1 && options.expireAfterSeconds === 0
        )).toBe(true);
    });

    it('exchanges a valid code and verifier for a JWT/user JSON result', async () => {
        const user = await createGoogleUser();
        const codeChallenge = derivePkceS256Challenge(PKCE_VERIFIER);
        const { rawCode, codeId } = await createGoogleOAuthLoginCode({
            userId: user._id,
            codeChallenge,
            codeChallengeMethod: 'S256',
        });

        const result = await authService.exchangeGoogleOAuthCode({
            code: rawCode,
            codeVerifier: PKCE_VERIFIER,
        });

        expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(result.user.id || result.user._id?.toString()).toBe(user._id.toString());

        const consumed = await GoogleOAuthLoginCode.findById(codeId);
        expect(consumed.consumedAt).toBeInstanceOf(Date);
    });

    it('rejects wrong verifiers without consuming the code', async () => {
        const user = await createGoogleUser();
        const { rawCode, codeId } = await createGoogleOAuthLoginCode({
            userId: user._id,
            codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
            codeChallengeMethod: 'S256',
        });

        await expect(authService.exchangeGoogleOAuthCode({
            code: rawCode,
            codeVerifier: OTHER_PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));

        const persisted = await GoogleOAuthLoginCode.findById(codeId);
        expect(persisted.consumedAt).toBeNull();
    });

    it('atomically consumes a code once and rejects replay', async () => {
        const user = await createGoogleUser();
        const { rawCode } = await createGoogleOAuthLoginCode({
            userId: user._id,
            codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
            codeChallengeMethod: 'S256',
        });

        const results = await Promise.allSettled([
            consumeGoogleOAuthLoginCode({ code: rawCode, codeVerifier: PKCE_VERIFIER }),
            consumeGoogleOAuthLoginCode({ code: rawCode, codeVerifier: PKCE_VERIFIER }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

        await expect(consumeGoogleOAuthLoginCode({
            code: rawCode,
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));
    });

    it('uses the same generic error for malformed, missing, unknown, expired, and inactive-user exchanges', async () => {
        await expect(authService.exchangeGoogleOAuthCode({
            code: '',
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));

        await expect(authService.exchangeGoogleOAuthCode({
            code: 'A'.repeat(300),
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));

        await expect(authService.exchangeGoogleOAuthCode({
            code: 'A'.repeat(43),
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));

        const inactiveUser = await createGoogleUser({ status: USER_STATUS.REJECTED });
        const expired = await createGoogleOAuthLoginCode({
            userId: inactiveUser._id,
            codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
            codeChallengeMethod: 'S256',
        });

        await GoogleOAuthLoginCode.updateOne(
            { _id: expired.codeId },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );

        await expect(authService.exchangeGoogleOAuthCode({
            code: expired.rawCode,
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));

        const inactive = await createGoogleOAuthLoginCode({
            userId: inactiveUser._id,
            codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
            codeChallengeMethod: 'S256',
        });

        await expect(authService.exchangeGoogleOAuthCode({
            code: inactive.rawCode,
            codeVerifier: PKCE_VERIFIER,
        })).rejects.toThrow(expect.objectContaining({ code: INVALID_OR_EXPIRED_OAUTH_CODE }));
    });
});

describe('Google OAuth callback handoff behavior', () => {
    it('redirects active Google users with oauth_code only, never a JWT or user data', async () => {
        const user = await createGoogleUser();
        const res = { redirect: jest.fn() };
        const next = jest.fn();

        await callController(authController.googleCallback, {
            user,
            googleOAuthContext: {
                stateId: new mongoose.Types.ObjectId(),
                codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
                codeChallengeMethod: 'S256',
            },
        }, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/auth?oauth_code='));
        const redirectUrl = res.redirect.mock.calls[0][0];
        expect(redirectUrl).not.toContain('token=');
        expect(redirectUrl).not.toContain(user.email);
        expect(redirectUrl).not.toContain(user._id.toString());
    });

    it('keeps pending users on the existing pending status redirect without a code', async () => {
        const user = await createGoogleUser({ status: USER_STATUS.PENDING });
        const res = { redirect: jest.fn() };

        await callController(authController.googleCallback, {
            user,
            googleOAuthContext: {
                codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
                codeChallengeMethod: 'S256',
            },
        }, res);

        expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/auth?status=pending'));
        expect(res.redirect.mock.calls[0][0]).not.toContain('oauth_code=');
        expect(res.redirect.mock.calls[0][0]).not.toContain('token=');
    });
});

describe('Google OAuth referral preservation through Stage 1D context', () => {
    it('preserves Stage 1C referral attribution while carrying PKCE context', async () => {
        const group = await createDefaultGroup();
        const inviter = await createCustomer({
            groupId: group._id,
            email: uniqueEmail('inviter'),
            referralCode: 'ABCDEFGHJK',
        });

        const user = await runGoogleVerify(
            {
                googleOAuthContext: {
                    referrerCode: 'ABCDEFGHJK',
                    codeChallenge: derivePkceS256Challenge(PKCE_VERIFIER),
                    codeChallengeMethod: 'S256',
                },
            },
            googleProfile({ email: uniqueEmail('new-google') })
        );
        const fresh = await User.findById(user._id).select('+referredBy +referredAt +referralSource');

        expect(fresh.referredBy.toString()).toBe(inviter._id.toString());
        expect(fresh.referredAt).toBeInstanceOf(Date);
        expect(fresh.referralSource).toBe(REFERRAL_SOURCE.GOOGLE_OAUTH);
    });
});
