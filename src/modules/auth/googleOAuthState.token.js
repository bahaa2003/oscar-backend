'use strict';

const crypto = require('crypto');

const GOOGLE_OAUTH_STATE_VERSION = 'v1';
const GOOGLE_OAUTH_STATE_NONCE_BYTES = 32;
const GOOGLE_OAUTH_STATE_MAX_LENGTH = 512;
const GOOGLE_OAUTH_STATE_CLOCK_SKEW_MS = 60 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const toBase64Url = (buffer) => Buffer.from(buffer).toString('base64url');

const requireSecret = (secret) => {
    const normalized = String(secret || '');
    if (!normalized) throw new Error('GOOGLE_OAUTH_STATE_SECRET is required.');
    return normalized;
};

const signStatePayload = (payload, secret) =>
    crypto
        .createHmac('sha256', requireSecret(secret))
        .update(payload)
        .digest('base64url');

const timingSafeEqualString = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const createGoogleOAuthStateToken = ({ secret, now = Date.now } = {}) => {
    const issuedAt = String(now());
    const nonce = toBase64Url(crypto.randomBytes(GOOGLE_OAUTH_STATE_NONCE_BYTES));
    const payload = `${GOOGLE_OAUTH_STATE_VERSION}.${nonce}.${issuedAt}`;
    const signature = signStatePayload(payload, secret);

    return `${payload}.${signature}`;
};

const verifyGoogleOAuthStateToken = (
    rawState,
    { secret, maxAgeMs, now = Date.now } = {}
) => {
    const state = String(rawState || '');
    if (!state) return { valid: false, reason: 'MISSING_STATE' };
    if (state.length > GOOGLE_OAUTH_STATE_MAX_LENGTH) {
        return { valid: false, reason: 'STATE_TOO_LONG' };
    }

    const parts = state.split('.');
    if (parts.length !== 4) return { valid: false, reason: 'MALFORMED_STATE' };

    const [version, nonce, issuedAtRaw, signature] = parts;
    if (version !== GOOGLE_OAUTH_STATE_VERSION) return { valid: false, reason: 'UNSUPPORTED_STATE_VERSION' };
    if (!nonce || !BASE64URL_PATTERN.test(nonce)) return { valid: false, reason: 'INVALID_STATE_NONCE' };
    if (!signature || !BASE64URL_PATTERN.test(signature)) return { valid: false, reason: 'INVALID_STATE_SIGNATURE' };

    const issuedAt = Number(issuedAtRaw);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
        return { valid: false, reason: 'INVALID_STATE_TIMESTAMP' };
    }

    const expectedSignature = signStatePayload(`${version}.${nonce}.${issuedAtRaw}`, secret);
    if (!timingSafeEqualString(signature, expectedSignature)) {
        return { valid: false, reason: 'INVALID_STATE_SIGNATURE' };
    }

    const currentTime = now();
    if (issuedAt > currentTime + GOOGLE_OAUTH_STATE_CLOCK_SKEW_MS) {
        return { valid: false, reason: 'STATE_ISSUED_IN_FUTURE' };
    }

    if (Number.isFinite(maxAgeMs) && currentTime - issuedAt > maxAgeMs) {
        return { valid: false, reason: 'STATE_EXPIRED' };
    }

    return {
        valid: true,
        reason: 'VALID',
        nonce,
        issuedAt,
    };
};

const hashOAuthValue = (value) =>
    crypto
        .createHash('sha256')
        .update(String(value || ''))
        .digest('hex');

const generateBrowserBindingToken = () =>
    toBase64Url(crypto.randomBytes(GOOGLE_OAUTH_STATE_NONCE_BYTES));

module.exports = {
    GOOGLE_OAUTH_STATE_VERSION,
    GOOGLE_OAUTH_STATE_NONCE_BYTES,
    GOOGLE_OAUTH_STATE_MAX_LENGTH,
    createGoogleOAuthStateToken,
    verifyGoogleOAuthStateToken,
    signStatePayload,
    hashOAuthValue,
    generateBrowserBindingToken,
    timingSafeEqualString,
};
