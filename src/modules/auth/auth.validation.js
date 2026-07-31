'use strict';

const { body } = require('express-validator');

const registerValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('Name is required')
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

    body('currency')
        .optional()
        .trim()
        .isLength({ min: 2, max: 10 }).withMessage('Currency code must be between 2 and 10 characters'),

    body('country')
        .optional()
        .trim()
        .isLength({ max: 100 }),

    body('phone')
        .optional()
        .trim()
        .isLength({ max: 30 }),

    body('username')
        .optional()
        .trim()
        .isLength({ max: 100 }),

    body('referrerCode')
        .optional()
        .isString().withMessage('Referrer code must be a string')
        .trim()
        .isLength({ max: 32 }).withMessage('Referrer code cannot exceed 32 characters'),

    body('invitationCode')
        .optional()
        .isString().withMessage('Invitation code must be a string')
        .trim()
        .isLength({ max: 32 }).withMessage('Invitation code cannot exceed 32 characters'),

    body('referralCode')
        .optional()
        .isString().withMessage('Referral code must be a string')
        .trim()
        .isLength({ max: 32 }).withMessage('Referral code cannot exceed 32 characters'),
];

const loginValidation = [
    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required'),
];

// ─── 2FA Validation ───────────────────────────────────────────────────────────

const enable2FAValidation = [
    body('code')
        .trim()
        .notEmpty().withMessage('2FA code is required')
        .isLength({ min: 6, max: 6 }).withMessage('2FA code must be exactly 6 digits')
        .isNumeric().withMessage('2FA code must contain only digits'),
];

const disable2FAValidation = [
    body('password')
        .optional()
        .isString().withMessage('Password must be a string'),
];

const verify2FAValidation = [
    body('tempToken')
        .notEmpty().withMessage('Temporary token is required')
        .isString().withMessage('Temporary token must be a string'),

    body('code')
        .trim()
        .notEmpty().withMessage('2FA code is required')
        .isLength({ min: 6, max: 6 }).withMessage('2FA code must be exactly 6 digits')
        .isNumeric().withMessage('2FA code must contain only digits'),
];

const googleOAuthExchangeValidation = [
    body('code')
        .trim()
        .notEmpty().withMessage('OAuth code is required')
        .isString().withMessage('OAuth code must be a string')
        .isLength({ min: 43, max: 256 }).withMessage('OAuth code length is invalid')
        .matches(/^[A-Za-z0-9_-]+$/).withMessage('OAuth code format is invalid'),

    body('codeVerifier')
        .trim()
        .notEmpty().withMessage('PKCE verifier is required')
        .isString().withMessage('PKCE verifier must be a string')
        .isLength({ min: 43, max: 128 }).withMessage('PKCE verifier length is invalid')
        .matches(/^[A-Za-z0-9._~-]+$/).withMessage('PKCE verifier format is invalid'),
];

module.exports = {
    registerValidation,
    loginValidation,
    enable2FAValidation,
    disable2FAValidation,
    verify2FAValidation,
    googleOAuthExchangeValidation,
};
