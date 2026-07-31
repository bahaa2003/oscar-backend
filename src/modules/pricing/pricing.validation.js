'use strict';

const { body, query } = require('express-validator');

const forbiddenPricingFields = [
    'unitPrice',
    'basePrice',
    'finalUnitPrice',
    'lineTotal',
    'subtotal',
    'total',
    'totalPrice',
    'priceCoins',
    'chargedAmount',
    'groupId',
    'percentage',
    'markupPercentage',
    'resellerStatus',
    'exchangeRate',
    'rateSnapshot',
    'userId',
];

const quoteValidation = [
    body('currency')
        .optional()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter code')
        .isAlpha().withMessage('currency must contain letters only'),
    body('items')
        .isArray({ min: 1, max: 100 }).withMessage('items must contain 1-100 entries'),
    body('items.*.productId')
        .notEmpty().withMessage('items[].productId is required')
        .isMongoId().withMessage('items[].productId must be a valid ObjectId'),
    body('items.*.quantity')
        .notEmpty().withMessage('items[].quantity is required')
        .isInt({ min: 1, max: 1000000 }).withMessage('items[].quantity must be a positive bounded integer'),
    body().custom((value) => {
        for (const field of forbiddenPricingFields) {
            if (Object.prototype.hasOwnProperty.call(value || {}, field)) {
                throw new Error('Client-supplied pricing fields are not accepted');
            }
        }
        for (const item of value?.items || []) {
            for (const field of forbiddenPricingFields) {
                if (Object.prototype.hasOwnProperty.call(item || {}, field)) {
                    throw new Error('Client-supplied pricing fields are not accepted');
                }
            }
        }
        return true;
    }),
];

const adminPreviewValidation = [
    query('userId').notEmpty().isMongoId().withMessage('userId must be a valid ObjectId'),
    query('productId').notEmpty().isMongoId().withMessage('productId must be a valid ObjectId'),
    query('quantity').optional().isInt({ min: 1, max: 1000000 }).withMessage('quantity must be a positive bounded integer'),
    query('currency').optional().isLength({ min: 3, max: 3 }).isAlpha().withMessage('currency must be a 3-letter code'),
];

module.exports = {
    quoteValidation,
    adminPreviewValidation,
};
