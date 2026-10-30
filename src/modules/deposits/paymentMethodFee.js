'use strict';

const { BusinessRuleError } = require('../../shared/errors/AppError');

// Payment destination QR images must always be produced by the authenticated
// payment image uploader. Keeping this validation at the settings boundary
// prevents arbitrary remote/data URLs from reaching customer-facing pages.
const PAYMENT_QR_IMAGE_PATH = /^\/uploads\/payments\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/i;

/**
 * Payment method fees are configuration supplied by admins and eventually
 * drive wallet mutations. Never coerce arbitrary values here: a malformed
 * setting must be fixed rather than silently becoming a financial value.
 */
const normalizePaymentMethodFeePercent = (value, { allowMissing = false } = {}) => {
    if (allowMissing && (value === undefined || value === null)) return 0;

    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new BusinessRuleError(
            'payment method feePercent must be a finite number between 0 and 100.',
            'INVALID_PAYMENT_METHOD_FEE_PERCENT'
        );
    }

    return value;
};

const validatePaymentGroupsFeePercent = (paymentGroups) => {
    if (!Array.isArray(paymentGroups)) {
        throw new BusinessRuleError('paymentGroups must be an array.', 'INVALID_PAYMENT_GROUPS');
    }

    paymentGroups.forEach((group) => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.methods)) return;
        group.methods.forEach((method) => {
            if (!method || typeof method !== 'object') return;
            if (Object.prototype.hasOwnProperty.call(method, 'feePercent')) {
                normalizePaymentMethodFeePercent(method.feePercent);
            }
        });
    });
};

const validatePaymentGroupsQrCodeImages = (paymentGroups) => {
    if (!Array.isArray(paymentGroups)) {
        throw new BusinessRuleError('paymentGroups must be an array.', 'INVALID_PAYMENT_GROUPS');
    }

    paymentGroups.forEach((group) => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.methods)) return;
        group.methods.forEach((method) => {
            if (!method || typeof method !== 'object') return;

            const value = method.qrCodeImage;
            // Legacy methods have no QR field; an empty/null value deliberately
            // means QR is not configured.
            if (value === undefined || value === null || value === '') return;

            if (typeof value !== 'string' || !PAYMENT_QR_IMAGE_PATH.test(value.trim())) {
                throw new BusinessRuleError(
                    'payment method qrCodeImage must be a payment image upload path.',
                    'INVALID_PAYMENT_METHOD_QR_IMAGE'
                );
            }
        });
    });
};

module.exports = {
    normalizePaymentMethodFeePercent,
    validatePaymentGroupsFeePercent,
    validatePaymentGroupsQrCodeImages,
};
