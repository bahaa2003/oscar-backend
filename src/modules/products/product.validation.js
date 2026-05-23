'use strict';

const { body, param, query } = require('express-validator');
const { PRICING_MODES, MARKUP_TYPES, EXECUTION_TYPES, DYNAMIC_FIELD_TYPES } = require('./product.model');
const { isPositive } = require('../../shared/utils/decimalPrecision');

/**
 * Custom validator: value must be a positive decimal (string or number).
 * Accepts any decimal string with unlimited precision (e.g. 50 dp).
 */
const isPositiveDecimalString = (value) => {
    if (value == null || value === '') return false;
    const n = Number(value);
    if (isNaN(n)) return false;
    return isPositive(value);
};

const validateDynamicFields = (fields = []) => {
    if (!Array.isArray(fields)) return true;

    const names = new Set();
    for (const field of fields) {
        if (!field || typeof field !== 'object') {
            throw new Error('Each dynamicFields item must be an object');
        }

        const normalizedName = String(field.name || '').trim().toLowerCase();
        if (!normalizedName) {
            throw new Error('dynamicFields[].name is required');
        }

        if (names.has(normalizedName)) {
            throw new Error('dynamicFields names must be unique');
        }
        names.add(normalizedName);
    }

    return true;
};

// ─── User-facing / shared validation ─────────────────────────────────────────

const productIdParam = [
    param('id').isMongoId().withMessage('Invalid product ID'),
];

const listProductsValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1–200'),
];

// ─── Admin: create standalone product ────────────────────────────────────────

const createProductValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('name is required')
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .notEmpty().withMessage('basePrice is required')
        .custom((v) => isPositiveDecimalString(v)).withMessage('basePrice must be > 0'),

    body('costPrice')
        .optional()
        .isFloat({ min: 0 }).withMessage('costPrice must be >= 0'),

    body('minQty')
        .notEmpty().withMessage('minQty is required')
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .notEmpty().withMessage('maxQty is required')
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1')
        .custom((v, { req }) => {
            if (parseInt(v) < parseInt(req.body.minQty)) {
                throw new Error('maxQty must be >= minQty');
            }
            return true;
        }),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isString().withMessage('image must be a string'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),

    body('provider')
        .optional({ nullable: true })
        .isMongoId().withMessage('provider must be a valid ObjectId'),

    body('providerProduct')
        .optional({ nullable: true })
        .isMongoId().withMessage('providerProduct must be a valid ObjectId'),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('syncPriceWithProvider')
        .optional()
        .isBoolean().withMessage('syncPriceWithProvider must be a boolean'),

    body('enableManualPrice')
        .optional()
        .isBoolean().withMessage('enableManualPrice must be a boolean'),

    body('manualPriceAdjustment')
        .optional()
        .custom((v) => v == null || !isNaN(Number(v))).withMessage('manualPriceAdjustment must be a valid decimal'),

    body('dynamicFields')
        .optional()
        .isArray().withMessage('dynamicFields must be an array')
        .custom(validateDynamicFields),

    body('dynamicFields.*.name')
        .optional()
        .isString().withMessage('dynamicFields[].name must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].name is required'),

    body('dynamicFields.*.label')
        .optional()
        .isString().withMessage('dynamicFields[].label must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].label is required'),

    body('dynamicFields.*.type')
        .optional()
        .isIn(DYNAMIC_FIELD_TYPES)
        .withMessage(`dynamicFields[].type must be one of: ${DYNAMIC_FIELD_TYPES.join(', ')}`),

    body('dynamicFields.*.required')
        .optional()
        .isBoolean().withMessage('dynamicFields[].required must be a boolean'),
];

// ─── Admin: publish from provider product ────────────────────────────────────

const publishProductValidation = [
    body('providerProductId')
        .notEmpty().withMessage('providerProductId is required')
        .isMongoId().withMessage('Invalid providerProductId'),

    body('name')
        .trim()
        .notEmpty().withMessage('name is required')
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .optional({ nullable: true })
        .custom((v) => v == null || isPositiveDecimalString(v)).withMessage('basePrice must be > 0, if provided'),

    body('costPrice')
        .optional()
        .isFloat({ min: 0 }).withMessage('costPrice must be >= 0'),

    body('minQty')
        .optional()
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .optional()
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1'),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isString().withMessage('image must be a string'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean(),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),

    body('dynamicFields')
        .optional()
        .isArray().withMessage('dynamicFields must be an array')
        .custom(validateDynamicFields),

    body('dynamicFields.*.name')
        .optional()
        .isString().withMessage('dynamicFields[].name must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].name is required'),

    body('dynamicFields.*.label')
        .optional()
        .isString().withMessage('dynamicFields[].label must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].label is required'),

    body('dynamicFields.*.type')
        .optional()
        .isIn(DYNAMIC_FIELD_TYPES)
        .withMessage(`dynamicFields[].type must be one of: ${DYNAMIC_FIELD_TYPES.join(', ')}`),

    body('dynamicFields.*.required')
        .optional()
        .isBoolean().withMessage('dynamicFields[].required must be a boolean'),
];

// ─── Admin: update product ────────────────────────────────────────────────────

const updateProductValidation = [
    param('id').isMongoId().withMessage('Invalid product ID'),

    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .optional()
        .custom((v) => v == null || isPositiveDecimalString(v)).withMessage('basePrice must be > 0'),

    body('costPrice')
        .optional()
        .isFloat({ min: 0 }).withMessage('costPrice must be >= 0'),

    body('minQty')
        .optional()
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .optional()
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1'),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isString().withMessage('image must be a string'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean(),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('syncPriceWithProvider')
        .optional()
        .isBoolean().withMessage('syncPriceWithProvider must be a boolean'),

    body('enableManualPrice')
        .optional()
        .isBoolean().withMessage('enableManualPrice must be a boolean'),

    body('manualPriceAdjustment')
        .optional()
        .custom((v) => v == null || !isNaN(Number(v))).withMessage('manualPriceAdjustment must be a valid decimal'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),

    body('provider')
        .optional({ nullable: true })
        .isMongoId().withMessage('provider must be a valid ObjectId'),

    body('providerProduct')
        .optional({ nullable: true })
        .isMongoId().withMessage('providerProduct must be a valid ObjectId'),

    body('dynamicFields')
        .optional()
        .isArray().withMessage('dynamicFields must be an array')
        .custom(validateDynamicFields),

    body('dynamicFields.*.name')
        .optional()
        .isString().withMessage('dynamicFields[].name must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].name is required'),

    body('dynamicFields.*.label')
        .optional()
        .isString().withMessage('dynamicFields[].label must be a string')
        .trim()
        .notEmpty().withMessage('dynamicFields[].label is required'),

    body('dynamicFields.*.type')
        .optional()
        .isIn(DYNAMIC_FIELD_TYPES)
        .withMessage(`dynamicFields[].type must be one of: ${DYNAMIC_FIELD_TYPES.join(', ')}`),

    body('dynamicFields.*.required')
        .optional()
        .isBoolean().withMessage('dynamicFields[].required must be a boolean'),
];

module.exports = {
    productIdParam,
    listProductsValidation,
    createProductValidation,
    publishProductValidation,
    updateProductValidation,
};
