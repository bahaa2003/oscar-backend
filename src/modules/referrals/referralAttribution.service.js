'use strict';

const { BusinessRuleError } = require('../../shared/errors/AppError');
const { User, USER_STATUS, REFERRAL_SOURCE } = require('../users/user.model');
const {
    REFERRAL_CODE_ALPHABET,
    REFERRAL_CODE_LENGTH,
    normalizeReferralCode,
} = require('./referralCode.generator');

const REGISTRATION_REFERRER_CODE_ALIASES = [
    'referrerCode',
    'invitationCode',
    'referralCode',
];

const OAUTH_REFERRER_CODE_ALIASES = [
    'referrerCode',
    'ref',
    'invitationCode',
    'referralCode',
];

const REFERRAL_ATTRIBUTION_REASONS = Object.freeze({
    APPLIED: 'APPLIED',
    NO_REFERRER_CODE: 'NO_REFERRER_CODE',
    INVALID_REFERRER_CODE: 'INVALID_REFERRER_CODE',
    REFERRER_INACTIVE: 'REFERRER_INACTIVE',
    SELF_REFERRAL_NOT_APPLIED: 'SELF_REFERRAL_NOT_APPLIED',
});

const REFERRER_CODE_MAX_LENGTH = 32;
const REFERRER_CODE_PATTERN = new RegExp(
    `^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`
);

const normalizeRegistrationEmail = (email) =>
    String(email || '').trim().toLowerCase();

const isStructurallyValidReferrerCode = (value) =>
    Boolean(value && value.length <= REFERRER_CODE_MAX_LENGTH && REFERRER_CODE_PATTERN.test(value));

const mapReferrerCodeAliases = (source = {}, aliases = REGISTRATION_REFERRER_CODE_ALIASES) => {
    const presentAliases = aliases
        .map((field) => ({ field, value: normalizeReferralCode(source[field]) }))
        .filter((entry) => entry.value);

    const uniqueValues = new Set(presentAliases.map((entry) => entry.value));
    if (uniqueValues.size > 1) {
        throw new BusinessRuleError(
            'Conflicting referrer code aliases were provided.',
            'CONFLICTING_REFERRER_CODES'
        );
    }

    const chosen = aliases
        .map((field) => normalizeReferralCode(source[field]))
        .find(Boolean);

    return {
        referrerCode: chosen,
        aliases: presentAliases.map((entry) => entry.field),
    };
};

const mapRegistrationReferrerCodeAliases = (body = {}) =>
    mapReferrerCodeAliases(body, REGISTRATION_REFERRER_CODE_ALIASES);

const mapOAuthReferrerCodeAliases = (query = {}) =>
    mapReferrerCodeAliases(query, OAUTH_REFERRER_CODE_ALIASES);

const resolveRegistrationReferrer = async ({ referrerCode, email }) => {
    const normalizedReferrerCode = normalizeReferralCode(referrerCode);
    if (!normalizedReferrerCode) {
        return {
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.NO_REFERRER_CODE,
            referrer: null,
            normalizedReferrerCode: undefined,
        };
    }

    if (!isStructurallyValidReferrerCode(normalizedReferrerCode)) {
        return {
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.INVALID_REFERRER_CODE,
            referrer: null,
            normalizedReferrerCode,
        };
    }

    const referrer = await User.findOne({ referralCode: normalizedReferrerCode })
        .select('email status referralCode deletedAt');

    if (!referrer || referrer.deletedAt) {
        return {
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.INVALID_REFERRER_CODE,
            referrer: null,
            normalizedReferrerCode,
        };
    }

    if (referrer.status !== USER_STATUS.ACTIVE) {
        return {
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.REFERRER_INACTIVE,
            referrer: null,
            normalizedReferrerCode,
        };
    }

    if (normalizeRegistrationEmail(referrer.email) === normalizeRegistrationEmail(email)) {
        return {
            applied: false,
            reason: REFERRAL_ATTRIBUTION_REASONS.SELF_REFERRAL_NOT_APPLIED,
            referrer: null,
            normalizedReferrerCode,
        };
    }

    return {
        applied: true,
        reason: REFERRAL_ATTRIBUTION_REASONS.APPLIED,
        referrer,
        normalizedReferrerCode,
    };
};

const createEmailRegistrationAttributionFields = (referrer) => {
    if (!referrer?._id) return {};

    return {
        referredBy: referrer._id,
        referredAt: new Date(),
        referralSource: REFERRAL_SOURCE.EMAIL_REGISTRATION,
    };
};

const createGoogleOAuthAttributionFields = (referrer) => {
    if (!referrer?._id) return {};

    return {
        referredBy: referrer._id,
        referredAt: new Date(),
        referralSource: REFERRAL_SOURCE.GOOGLE_OAUTH,
    };
};

module.exports = {
    REGISTRATION_REFERRER_CODE_ALIASES,
    OAUTH_REFERRER_CODE_ALIASES,
    REFERRAL_ATTRIBUTION_REASONS,
    REFERRER_CODE_MAX_LENGTH,
    mapReferrerCodeAliases,
    mapRegistrationReferrerCodeAliases,
    mapOAuthReferrerCodeAliases,
    resolveRegistrationReferrer,
    createEmailRegistrationAttributionFields,
    createGoogleOAuthAttributionFields,
    normalizeRegistrationEmail,
    isStructurallyValidReferrerCode,
};
