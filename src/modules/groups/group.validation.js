'use strict';

const { body, param } = require('express-validator');
const mongoose = require('mongoose');

// ─── Create Group ─────────────────────────────────────────────────────────────
const createGroupValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('Group name is required')
        .isLength({ min: 2, max: 100 }).withMessage('Group name must be between 2 and 100 characters'),

    body('percentage')
        .notEmpty().withMessage('Percentage is required')
        .isFloat({ min: 0 }).withMessage('Percentage must be a non-negative number'),

    body('billingMode')
        .optional()
        .isIn(['standard', 'quantity_only']).withMessage('billingMode must be "standard" or "quantity_only"'),
];

// ─── Update Percentage ────────────────────────────────────────────────────────
const updatePercentageValidation = [
    param('id')
        .custom((v) => mongoose.Types.ObjectId.isValid(v))
        .withMessage('Invalid group ID'),

    body('percentage')
        .notEmpty().withMessage('Percentage is required')
        .isFloat({ min: 0 }).withMessage('Percentage must be a non-negative number'),
];

// ─── Update Group (general) ────────────────────────────────────────────────────
const updateGroupValidation = [
    param('id')
        .custom((v) => mongoose.Types.ObjectId.isValid(v))
        .withMessage('Invalid group ID'),

    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 }).withMessage('Group name must be between 2 and 100 characters'),

    body('percentage')
        .optional()
        .isFloat({ min: 0 }).withMessage('Percentage must be a non-negative number'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),

    body('billingMode')
        .optional()
        .isIn(['standard', 'quantity_only']).withMessage('billingMode must be "standard" or "quantity_only"'),
];

// ─── Change User's Group ──────────────────────────────────────────────────────
const changeUserGroupValidation = [
    param('userId')
        .custom((v) => mongoose.Types.ObjectId.isValid(v))
        .withMessage('Invalid user ID'),

    body('groupId')
        .notEmpty().withMessage('groupId is required')
        .custom((v) => mongoose.Types.ObjectId.isValid(v))
        .withMessage('Invalid group ID'),
];

module.exports = {
    createGroupValidation,
    updatePercentageValidation,
    updateGroupValidation,
    changeUserGroupValidation,
};
