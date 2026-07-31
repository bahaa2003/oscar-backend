'use strict';

const config = require('../config/config');
const GoogleOAuthState = require('../modules/auth/googleOAuthState.model');
const {
    createGoogleOAuthStateToken,
    verifyGoogleOAuthStateToken,
    hashOAuthValue,
} = require('../modules/auth/googleOAuthState.token');
const {
    createGoogleOAuthState,
    consumeGoogleOAuthState,
    resolveOAuthPkceChallenge,
    resolveOAuthReferrerCode,
} = require('../modules/auth/googleOAuthState.service');
const {
    buildGoogleOAuthBindingCookie,
    getGoogleOAuthBindingCookie,
} = require('../modules/auth/googleOAuthState.cookies');
const {
    startGoogleOAuthState,
    consumeGoogleOAuthStateMiddleware,
} = require('../modules/auth/googleOAuthState.middleware');
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

const VALID_PKCE_CHALLENGE = 'A'.repeat(43);
const validPkceQuery = (overrides = {}) => ({
    codeChallenge: VALID_PKCE_CHALLENGE,
    codeChallengeMethod: 'S256',
    ...overrides,
});

const makeRes = () => {
    const headers = {};

    return {
        redirectUrl: null,
        getHeader: (name) => headers[name],
        setHeader: (name, value) => {
            headers[name] = value;
        },
        redirect: jest.fn((url) => {
            this.redirectUrl = url;
        }),
        headers,
    };
};

describe('Google OAuth state token', () => {
    it('creates signed, unique, verifiable v1 state tokens', () => {
        const first = createGoogleOAuthStateToken({
            secret: config.google.oauthStateSecret,
            now: () => 1000,
        });
        const second = createGoogleOAuthStateToken({
            secret: config.google.oauthStateSecret,
            now: () => 1000,
        });

        expect(first).not.toBe(second);
        expect(first.split('.')).toHaveLength(4);
        expect(first.startsWith('v1.')).toBe(true);
        expect(verifyGoogleOAuthStateToken(first, {
            secret: config.google.oauthStateSecret,
            maxAgeMs: 600000,
            now: () => 2000,
        })).toMatchObject({
            valid: true,
            reason: 'VALID',
            issuedAt: 1000,
        });
    });

    it('rejects tampered, malformed, oversized, and expired states', () => {
        const state = createGoogleOAuthStateToken({
            secret: config.google.oauthStateSecret,
            now: () => 1000,
        });
        const parts = state.split('.');
        const tampered = [parts[0], parts[1], '1001', parts[3]].join('.');

        expect(verifyGoogleOAuthStateToken(tampered, {
            secret: config.google.oauthStateSecret,
            maxAgeMs: 600000,
            now: () => 2000,
        }).valid).toBe(false);
        expect(verifyGoogleOAuthStateToken('not-enough-parts', {
            secret: config.google.oauthStateSecret,
            maxAgeMs: 600000,
        }).valid).toBe(false);
        expect(verifyGoogleOAuthStateToken(`v1.${'A'.repeat(600)}`, {
            secret: config.google.oauthStateSecret,
            maxAgeMs: 600000,
        }).reason).toBe('STATE_TOO_LONG');
        expect(verifyGoogleOAuthStateToken(state, {
            secret: config.google.oauthStateSecret,
            maxAgeMs: 500,
            now: () => 2000,
        }).reason).toBe('STATE_EXPIRED');
    });
});

describe('Google OAuth state persistence and browser binding', () => {
    it('stores only hashes and bounded metadata, not raw state or raw binding', async () => {
        const context = await createGoogleOAuthState({
            query: validPkceQuery({ ref: ' abcdefghjk ' }),
            now: () => 1000,
        });
        const persisted = await GoogleOAuthState.findById(context.stateId);

        expect(context.rawState).toContain('v1.');
        expect(persisted.stateHash).toBe(hashOAuthValue(context.rawState));
        expect(persisted.browserBindingHash).toBe(hashOAuthValue(context.browserBindingToken));
        expect(persisted.stateHash).not.toBe(context.rawState);
        expect(persisted.browserBindingHash).not.toBe(context.browserBindingToken);
        expect(persisted.referrerCode).toBe('ABCDEFGHJK');
        expect(persisted.codeChallenge).toBe(VALID_PKCE_CHALLENGE);
        expect(persisted.codeChallengeMethod).toBe('S256');
        expect(persisted.toObject().codeVerifier).toBeUndefined();
        expect(persisted.expiresAt.getTime()).toBe(1000 + config.google.oauthStateTtlMs);
    });

    it('defines a TTL index and unique state hash index', async () => {
        const indexes = GoogleOAuthState.schema.indexes();
        expect(indexes.some(([fields, options]) =>
            fields.expiresAt === 1 && options.expireAfterSeconds === 0
        )).toBe(true);
        expect(indexes.some(([fields, options]) =>
            fields.stateHash === 1 && options.unique === true
        )).toBe(true);
    });

    it('atomically consumes a matching state once', async () => {
        const context = await createGoogleOAuthState({
            query: validPkceQuery({ referrerCode: 'ABCDEFGHJK' }),
        });

        const results = await Promise.allSettled([
            consumeGoogleOAuthState({
                rawState: context.rawState,
                browserBindingToken: context.browserBindingToken,
            }),
            consumeGoogleOAuthState({
                rawState: context.rawState,
                browserBindingToken: context.browserBindingToken,
            }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const persisted = await GoogleOAuthState.findById(context.stateId);
        expect(persisted.consumedAt).toBeInstanceOf(Date);
    });

    it('rejects missing, mismatched, and explicitly expired browser-bound state', async () => {
        const context = await createGoogleOAuthState({ query: validPkceQuery() });

        await expect(consumeGoogleOAuthState({
            rawState: context.rawState,
            browserBindingToken: '',
        })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_STATE' }));

        await expect(consumeGoogleOAuthState({
            rawState: context.rawState,
            browserBindingToken: 'wrong-binding',
        })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_STATE' }));

        await GoogleOAuthState.updateOne(
            { _id: context.stateId },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );

        await expect(consumeGoogleOAuthState({
            rawState: context.rawState,
            browserBindingToken: context.browserBindingToken,
        })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_STATE' }));
    });

    it('normalizes OAuth referrer aliases and rejects conflicts', () => {
        expect(resolveOAuthReferrerCode({ ref: ' abcdefghjk ' }).referrerCode).toBe('ABCDEFGHJK');
        expect(resolveOAuthReferrerCode({
            referrerCode: 'ABCDEFGHJK',
            ref: 'abcdefghjk',
        }).referrerCode).toBe('ABCDEFGHJK');
        expect(() => resolveOAuthReferrerCode({
            referrerCode: 'ABCDEFGHJK',
            ref: 'BCDEFGHJKL',
        })).toThrow(expect.objectContaining({ code: 'CONFLICTING_REFERRER_CODES' }));
    });

    it('requires a trusted S256 PKCE challenge before persisting state', async () => {
        expect(resolveOAuthPkceChallenge(validPkceQuery())).toEqual({
            codeChallenge: VALID_PKCE_CHALLENGE,
            codeChallengeMethod: 'S256',
        });

        await expect(createGoogleOAuthState({ query: {} }))
            .rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_PKCE' }));
        await expect(createGoogleOAuthState({
            query: validPkceQuery({ codeChallenge: 'short' }),
        })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_PKCE' }));
        await expect(createGoogleOAuthState({
            query: validPkceQuery({ codeChallengeMethod: 'plain' }),
        })).rejects.toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_OAUTH_PKCE' }));

        expect(await GoogleOAuthState.countDocuments()).toBe(0);
    });

    it('builds an HttpOnly callback-path Lax browser binding cookie', () => {
        const cookie = buildGoogleOAuthBindingCookie('secret-binding', {
            maxAgeMs: 600000,
            secure: true,
        });

        expect(cookie).toContain('google_oauth_binding=secret-binding');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/api/auth/google/callback');
        expect(cookie).toContain('Max-Age=600');
        expect(cookie).toContain('Secure');
        expect(getGoogleOAuthBindingCookie({
            headers: { cookie: 'other=1; google_oauth_binding=secret-binding' },
        })).toBe('secret-binding');
    });
});

describe('Google OAuth state middleware', () => {
    it('creates raw state for Passport and a hashed binding cookie for the browser', async () => {
        const req = { query: validPkceQuery({ referrerCode: 'ABCDEFGHJK' }) };
        const res = makeRes();
        const next = jest.fn();

        await startGoogleOAuthState(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.googleOAuthState.rawState).toMatch(/^v1\./);
        expect(req.googleOAuthState.codeChallenge).toBe(VALID_PKCE_CHALLENGE);
        expect(req.googleOAuthState.codeChallengeMethod).toBe('S256');
        expect(res.headers['Set-Cookie']).toContain('HttpOnly');

        const persisted = await GoogleOAuthState.findById(req.googleOAuthState.stateId);
        expect(persisted.stateHash).toBe(hashOAuthValue(req.googleOAuthState.rawState));
        expect(res.headers['Set-Cookie']).not.toContain(req.googleOAuthState.rawState);
    });

    it('consumes valid state before Passport and redirects invalid callback state', async () => {
        const state = await createGoogleOAuthState({
            query: validPkceQuery({ referrerCode: 'ABCDEFGHJK' }),
        });
        const validReq = {
            query: { state: state.rawState },
            headers: { cookie: `google_oauth_binding=${state.browserBindingToken}` },
        };
        const validRes = makeRes();
        const validNext = jest.fn();

        await consumeGoogleOAuthStateMiddleware(validReq, validRes, validNext);
        expect(validNext).toHaveBeenCalledTimes(1);
        expect(validReq.googleOAuthContext.referrerCode).toBe('ABCDEFGHJK');
        expect(validReq.googleOAuthContext.codeChallenge).toBe(VALID_PKCE_CHALLENGE);
        expect(validReq.googleOAuthContext.codeChallengeMethod).toBe('S256');

        const invalidReq = { query: { state: state.rawState }, headers: { cookie: '' } };
        const invalidRes = makeRes();
        const invalidNext = jest.fn();

        await consumeGoogleOAuthStateMiddleware(invalidReq, invalidRes, invalidNext);
        expect(invalidNext).not.toHaveBeenCalled();
        expect(invalidRes.redirect).toHaveBeenCalledWith(expect.stringContaining('oauth_error=invalid_state'));
    });
});
