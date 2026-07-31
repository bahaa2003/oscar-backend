'use strict';

const crypto = require('crypto');
const config = require('../../config/config');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const GoogleOAuthLoginCode = require('./googleOAuthLoginCode.model');
const { hashOAuthValue, timingSafeEqualString } = require('./googleOAuthState.token');

const INVALID_OR_EXPIRED_OAUTH_CODE = 'INVALID_OR_EXPIRED_OAUTH_CODE';
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const OAUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

const invalidOAuthCodeError = () =>
    new BusinessRuleError(
        'Invalid or expired OAuth login code.',
        INVALID_OR_EXPIRED_OAUTH_CODE
    );

const derivePkceS256Challenge = (codeVerifier) => {
    const verifier = String(codeVerifier || '').trim();
    if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw invalidOAuthCodeError();

    return crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
};

const assertOAuthCodeShape = (code) => {
    const normalizedCode = String(code || '').trim();
    if (!OAUTH_CODE_PATTERN.test(normalizedCode)) throw invalidOAuthCodeError();
    return normalizedCode;
};

const createGoogleOAuthLoginCode = async ({
    userId,
    codeChallenge,
    codeChallengeMethod = 'S256',
    oauthStateId = null,
    now = Date.now,
} = {}) => {
    if (!userId || !codeChallenge || codeChallengeMethod !== 'S256') {
        throw new Error('Valid Google OAuth handoff context is required.');
    }

    const issuedAt = now();
    const rawCode = crypto.randomBytes(32).toString('base64url');
    const document = await GoogleOAuthLoginCode.create({
        codeHash: hashOAuthValue(rawCode),
        userId,
        provider: 'GOOGLE',
        codeChallenge,
        codeChallengeMethod,
        oauthStateId,
        expiresAt: new Date(issuedAt + config.google.oauthHandoffTtlMs),
    });

    return {
        rawCode,
        expiresAt: document.expiresAt,
        codeId: document._id,
    };
};

const consumeGoogleOAuthLoginCode = async ({
    code,
    codeVerifier,
    now = Date.now,
} = {}) => {
    const rawCode = assertOAuthCodeShape(code);
    const derivedChallenge = derivePkceS256Challenge(codeVerifier);
    const codeHash = hashOAuthValue(rawCode);
    const currentTime = new Date(now());

    const candidate = await GoogleOAuthLoginCode.findOne({
        codeHash,
        provider: 'GOOGLE',
        consumedAt: null,
        expiresAt: { $gt: currentTime },
    });

    if (!candidate) throw invalidOAuthCodeError();
    if (
        candidate.codeChallengeMethod !== 'S256' ||
        !timingSafeEqualString(derivedChallenge, candidate.codeChallenge)
    ) {
        throw invalidOAuthCodeError();
    }

    const consumed = await GoogleOAuthLoginCode.findOneAndUpdate(
        {
            _id: candidate._id,
            consumedAt: null,
            expiresAt: { $gt: currentTime },
        },
        { $set: { consumedAt: currentTime } },
        { new: true }
    );

    if (!consumed) throw invalidOAuthCodeError();

    return {
        userId: consumed.userId,
        codeId: consumed._id,
        consumedAt: consumed.consumedAt,
    };
};

module.exports = {
    INVALID_OR_EXPIRED_OAUTH_CODE,
    PKCE_VERIFIER_PATTERN,
    OAUTH_CODE_PATTERN,
    derivePkceS256Challenge,
    createGoogleOAuthLoginCode,
    consumeGoogleOAuthLoginCode,
};
