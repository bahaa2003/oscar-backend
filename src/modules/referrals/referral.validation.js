'use strict';

const { body, param, query } = require('express-validator');
const { COMMISSION_STATUS } = require('./referralCommission.model');
const { PAYOUT_METHOD, PAYOUT_STATUS } = require('./referralPayoutRequest.model');
const { REFERRAL_SOURCE } = require('../users/user.model');

const rejectOwnershipOverride = [
    query(['referrerId', 'userId', 'referredBy'])
        .not()
        .exists()
        .withMessage('Client-supplied referral ownership fields are not accepted'),
];

const paginationValidation = [
    query('page')
        .optional()
        .isInt({ min: 1 })
        .withMessage('page must be an integer greater than or equal to 1'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('limit must be an integer between 1 and 100'),
];

const dateRangeValidation = [
    query('dateFrom')
        .optional()
        .isISO8601({ strict: true })
        .withMessage('dateFrom must be a valid ISO date'),
    query('dateTo')
        .optional()
        .isISO8601({ strict: true })
        .withMessage('dateTo must be a valid ISO date')
        .custom((dateTo, { req }) => {
            if (!req.query.dateFrom) return true;
            return new Date(req.query.dateFrom).getTime() <= new Date(dateTo).getTime();
        })
        .withMessage('dateFrom must be before or equal to dateTo'),
];

const commissionListValidation = [
    ...rejectOwnershipOverride,
    ...paginationValidation,
    ...dateRangeValidation,
    query('status')
        .optional()
        .customSanitizer((value) => String(value || '').trim().toUpperCase())
        .isIn(Object.values(COMMISSION_STATUS))
        .withMessage('status must be one of AVAILABLE, LOCKED, PAID, CANCELLED'),
];

const inviteeListValidation = [
    ...rejectOwnershipOverride,
    ...paginationValidation,
    ...dateRangeValidation,
    query('source')
        .optional()
        .customSanitizer((value) => String(value || '').trim().toUpperCase())
        .isIn(Object.values(REFERRAL_SOURCE))
        .withMessage('source must be EMAIL_REGISTRATION or GOOGLE_OAUTH'),
];

const dashboardValidation = [
    ...rejectOwnershipOverride,
];

const payoutListValidation = [
    ...rejectOwnershipOverride,
    ...paginationValidation,
    ...dateRangeValidation,
    query('status')
        .optional()
        .customSanitizer((value) => String(value || '').trim().toUpperCase())
        .isIn(Object.values(PAYOUT_STATUS))
        .withMessage('status must be PENDING, PAID, or REJECTED'),
    query('method')
        .optional()
        .customSanitizer((value) => String(value || '').trim().toUpperCase())
        .isIn(Object.values(PAYOUT_METHOD))
        .withMessage('method must be WALLET or MANUAL'),
];

const createPayoutValidation = [
    body(['referrerId', 'amountUsd', 'currency', 'status', 'walletTransactionId', 'reviewedBy', 'paidAt'])
        .not()
        .exists()
        .withMessage('Client-supplied payout ownership or financial state fields are not accepted'),
    body('commissionIds')
        .isArray({ min: 1, max: 100 })
        .withMessage('commissionIds must be a non-empty array with at most 100 items'),
    body('commissionIds.*')
        .isMongoId()
        .withMessage('commissionIds must contain valid ObjectIds'),
    body('method')
        .customSanitizer((value) => String(value || '').trim().toUpperCase())
        .isIn(Object.values(PAYOUT_METHOD))
        .withMessage('method must be WALLET or MANUAL'),
];

const payoutIdParamValidation = [
    param('id').isMongoId().withMessage('id must be a valid ObjectId'),
];

module.exports = {
    dashboardValidation,
    commissionListValidation,
    inviteeListValidation,
    payoutListValidation,
    createPayoutValidation,
    payoutIdParamValidation,
};
