'use strict';

const config = require('../../config/config');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const { normalizeReferralCode } = require('../referrals/referralCode.generator');
const {
    REFERRER_CODE_MAX_LENGTH,
    mapOAuthReferrerCodeAliases,
} = require('../referrals/referralAttribution.service');
const GoogleOAuthState = require('./googleOAuthState.model');
const {
    createGoogleOAuthStateToken,
    verifyGoogleOAuthStateToken,
    hashOAuthValue,
    generateBrowserBindingToken,
} = require('./googleOAuthState.token');

const GOOGLE_OAUTH_STATE_ERROR_CODE = 'INVALID_GOOGLE_OAUTH_STATE';
const GOOGLE_OAUTH_PKCE_ERROR_CODE = 'INVALID_GOOGLE_OAUTH_PKCE';
const PKCE_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CODE_CHALLENGE_METHOD = 'S256';

const getGoogleOAuthStateSecret = () => {
    if (!config.google.oauthStateSecret) {
        throw new Error('GOOGLE_OAUTH_STATE_SECRET is required for Google OAuth.');
    }

    return config.google.oauthStateSecret;
};

const getGoogleOAuthStateTtlMs = () => config.google.oauthStateTtlMs;

const invalidStateError = (reason = GOOGLE_OAUTH_STATE_ERROR_CODE) =>
    new BusinessRuleError('Invalid or expired Google OAuth state.', reason);

const resolveOAuthReferrerCode = (query = {}) => {
    const { referrerCode, aliases } = mapOAuthReferrerCodeAliases(query);
    const normalizedReferrerCode = normalizeReferralCode(referrerCode);

    if (normalizedReferrerCode && normalizedReferrerCode.length > REFERRER_CODE_MAX_LENGTH) {
        throw new BusinessRuleError(
            'Referrer code is too long.',
            'REFERRER_CODE_TOO_LONG'
        );
    }

    return {
        referrerCode: normalizedReferrerCode || null,
        aliases,
    };
};

const resolveOAuthPkceChallenge = (query = {}) => {
    const codeChallenge = String(query.codeChallenge || '').trim();
    const codeChallengeMethod = String(query.codeChallengeMethod || '').trim();

    if (
        !codeChallenge ||
        !PKCE_CODE_CHALLENGE_PATTERN.test(codeChallenge) ||
        codeChallengeMethod !== PKCE_CODE_CHALLENGE_METHOD
    ) {
        throw new BusinessRuleError(
            'Google OAuth PKCE challenge is required.',
            GOOGLE_OAUTH_PKCE_ERROR_CODE
        );
    }

    return {
        codeChallenge,
        codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
    };
};

const createGoogleOAuthState = async ({ query = {}, now = Date.now } = {}) => {
    const secret = getGoogleOAuthStateSecret();
    const maxAgeMs = getGoogleOAuthStateTtlMs();
    const issuedAt = now();
    const { referrerCode } = resolveOAuthReferrerCode(query);
    const { codeChallenge, codeChallengeMethod } = resolveOAuthPkceChallenge(query);
    const rawState = createGoogleOAuthStateToken({ secret, now: () => issuedAt });
    const browserBindingToken = generateBrowserBindingToken();

    const stateDocument = await GoogleOAuthState.create({
        stateHash: hashOAuthValue(rawState),
        browserBindingHash: hashOAuthValue(browserBindingToken),
        provider: 'GOOGLE',
        version: 'v1',
        referrerCode,
        codeChallenge,
        codeChallengeMethod,
        expiresAt: new Date(issuedAt + maxAgeMs),
    });

    return {
        rawState,
        browserBindingToken,
        expiresAt: stateDocument.expiresAt,
        maxAgeMs,
        stateId: stateDocument._id,
        referrerCode,
        codeChallenge,
        codeChallengeMethod,
    };
};

const consumeGoogleOAuthState = async ({
    rawState,
    browserBindingToken,
    now = Date.now,
} = {}) => {
    if (!browserBindingToken) throw invalidStateError();

    const secret = getGoogleOAuthStateSecret();
    const maxAgeMs = getGoogleOAuthStateTtlMs();
    const verification = verifyGoogleOAuthStateToken(rawState, {
        secret,
        maxAgeMs,
        now,
    });

    if (!verification.valid) throw invalidStateError();

    const consumedAt = new Date(now());
    const stateDocument = await GoogleOAuthState.findOneAndUpdate(
        {
            stateHash: hashOAuthValue(rawState),
            browserBindingHash: hashOAuthValue(browserBindingToken),
            provider: 'GOOGLE',
            consumedAt: null,
            expiresAt: { $gt: consumedAt },
        },
        { $set: { consumedAt } },
        { new: true }
    );

    if (!stateDocument) throw invalidStateError();

    return {
        stateId: stateDocument._id,
        referrerCode: stateDocument.referrerCode || null,
        codeChallenge: stateDocument.codeChallenge,
        codeChallengeMethod: stateDocument.codeChallengeMethod,
        consumedAt: stateDocument.consumedAt,
    };
};

module.exports = {
    GOOGLE_OAUTH_STATE_ERROR_CODE,
    GOOGLE_OAUTH_PKCE_ERROR_CODE,
    PKCE_CODE_CHALLENGE_METHOD,
    getGoogleOAuthStateSecret,
    getGoogleOAuthStateTtlMs,
    resolveOAuthReferrerCode,
    resolveOAuthPkceChallenge,
    createGoogleOAuthState,
    consumeGoogleOAuthState,
};
