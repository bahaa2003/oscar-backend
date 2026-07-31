'use strict';

const { BusinessRuleError } = require('../../shared/errors/AppError');
const {
    generateReferralCodeCandidate,
    normalizeReferralCode,
} = require('./referralCode.generator');

const REFERRAL_CODE_MAX_RETRIES = 8;

const isReferralCodeDuplicateError = (err) => {
    if (!err || err.code !== 11000) return false;

    if (err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'referralCode')) {
        return true;
    }

    if (err.keyValue && Object.prototype.hasOwnProperty.call(err.keyValue, 'referralCode')) {
        return true;
    }

    return typeof err.message === 'string' && err.message.includes('referralCode');
};

const referralCodeGenerationError = () =>
    new BusinessRuleError(
        'Unable to generate a unique referral code. Please retry the operation.',
        'REFERRAL_CODE_GENERATION_FAILED'
    );

const createUserWithReferralCode = async (userData, { User, maxRetries = REFERRAL_CODE_MAX_RETRIES } = {}) => {
    if (!User) throw new Error('User model is required.');

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            return await User.create({
                ...userData,
                referralCode: generateReferralCodeCandidate(),
            });
        } catch (err) {
            if (!isReferralCodeDuplicateError(err) || attempt === maxRetries) {
                if (isReferralCodeDuplicateError(err)) throw referralCodeGenerationError();
                throw err;
            }
        }
    }

    throw referralCodeGenerationError();
};

const assignMissingReferralCode = async (userId, { User, maxRetries = REFERRAL_CODE_MAX_RETRIES } = {}) => {
    if (!User) throw new Error('User model is required.');

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const referralCode = generateReferralCodeCandidate();

        try {
            const result = await User.updateOne(
                {
                    _id: userId,
                    $or: [
                        { referralCode: { $exists: false } },
                        { referralCode: null },
                        { referralCode: '' },
                    ],
                },
                { $set: { referralCode } },
                { runValidators: true }
            );

            return {
                referralCode,
                modified: result.modifiedCount === 1,
            };
        } catch (err) {
            if (!isReferralCodeDuplicateError(err) || attempt === maxRetries) {
                if (isReferralCodeDuplicateError(err)) throw referralCodeGenerationError();
                throw err;
            }
        }
    }

    throw referralCodeGenerationError();
};

module.exports = {
    REFERRAL_CODE_MAX_RETRIES,
    generateReferralCodeCandidate,
    normalizeReferralCode,
    isReferralCodeDuplicateError,
    createUserWithReferralCode,
    assignMissingReferralCode,
};
