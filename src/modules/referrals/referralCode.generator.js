'use strict';

const crypto = require('crypto');

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 10;

const normalizeReferralCode = (value) => {
    if (value == null) return value;
    const normalized = String(value).trim().toUpperCase();
    return normalized || undefined;
};

const generateReferralCodeCandidate = (length = REFERRAL_CODE_LENGTH) => {
    let code = '';
    for (let i = 0; i < length; i += 1) {
        const index = crypto.randomInt(0, REFERRAL_CODE_ALPHABET.length);
        code += REFERRAL_CODE_ALPHABET[index];
    }
    return code;
};

module.exports = {
    REFERRAL_CODE_ALPHABET,
    REFERRAL_CODE_LENGTH,
    normalizeReferralCode,
    generateReferralCodeCandidate,
};
