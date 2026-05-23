'use strict';

/**
 * me.routes.js — User Panel API
 *
 * All routes require:
 *  1. authenticate  — valid JWT
 *  2. requireActiveUser — account status === ACTIVE (admin-approved)
 *
 * Route map:
 *
 *  GET  /api/me                        Profile + wallet balance
 *  GET  /api/me/wallet                 Wallet summary + 5 recent txns
 *  GET  /api/me/wallet/transactions    Paginated transaction history
 *
 *  GET  /api/me/products               Active product catalogue (search, page, limit)
 *  GET  /api/me/products/:id           Single product detail
 *
 *  POST /api/me/orders                 Place a new order
 *  GET  /api/me/orders                 My orders (status, date, page, limit)
 *  GET  /api/me/orders/:id             My order detail (ownership enforced)
 *
 *  POST /api/me/deposits               Submit deposit request (multipart: receipt)
 *  GET  /api/me/deposits               My deposit history
 *  GET  /api/me/deposits/:id           My deposit detail (ownership enforced)
 */

const { Router } = require('express');
const me = require('./me.controller');
const depositController = require('../deposits/deposit.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { createUpload } = require('../../shared/middlewares/upload');
const { body, param, query } = require('express-validator');
const validate = require('../../shared/middlewares/validate');

const depositUpload = createUpload('deposits');

const router = Router();

// ── Global guards ─────────────────────────────────────────────────────────────
router.use(authenticate, requireActiveUser);

// ─── Profile ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/me
 * @desc   Authenticated user's own profile
 * @access Active user
 */
router.get('/', me.getProfile);

// ─── Wallet ───────────────────────────────────────────────────────────────────

router.get('/wallet', me.getWallet);
router.get('/wallet/transactions', me.getTransactions);

// ─── Products (read-only catalogue) ──────────────────────────────────────────

router.get(
    '/products',
    [
        query('search').optional().isString().trim(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validate,
    me.getProducts
);

router.get(
    '/products/:id',
    [param('id').isMongoId().withMessage('Invalid product ID')],
    validate,
    me.getProduct
);

// ─── Orders ───────────────────────────────────────────────────────────────────

const createOrderValidation = [
    body('productId')
        .notEmpty().withMessage('productId is required')
        .isMongoId().withMessage('productId must be a valid Mongo ID'),
    body('quantity')
        .optional()
        .isInt({ min: 1 }).withMessage('quantity must be a positive integer'),
];

router.post('/orders', createOrderValidation, validate, me.placeOrder);
router.get('/orders', me.getOrders);
router.get(
    '/orders/:id',
    [param('id').isMongoId().withMessage('Invalid order ID')],
    validate,
    me.getOrder
);

// ─── Deposits ─────────────────────────────────────────────────────────────────

const createDepositValidation = [
    body('requestedAmount')
        .notEmpty().withMessage('requestedAmount is required')
        .isFloat({ gt: 0 }).withMessage('requestedAmount must be a positive number'),
    body('currency')
        .notEmpty().withMessage('currency is required')
        .isString().trim()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),
    body('paymentMethodId')
        .notEmpty().withMessage('paymentMethodId is required')
        .isString().trim(),
    body('notes')
        .optional()
        .isString().trim()
        .isLength({ max: 500 }).withMessage('notes cannot exceed 500 characters'),
    body('senderDetails')
        .optional()
        .custom((value) => typeof value === 'string' || (value && typeof value === 'object'))
        .withMessage('senderDetails must be an object or JSON string'),
    body('senderWalletNumber')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('senderWalletNumber cannot exceed 200 characters'),
    body('senderWalletAddress')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('senderWalletAddress cannot exceed 200 characters'),
    body('transferredFromNumber')
        .optional()
        .isString().trim()
        .isLength({ max: 200 }).withMessage('transferredFromNumber cannot exceed 200 characters'),
];

/**
 * @route  POST /api/me/deposits
 * @desc   Submit a deposit request with receipt upload (multi-currency)
 * @access Active user
 * @body   multipart/form-data: requestedAmount, currency, paymentMethodId, receipt (file), notes?
 */
router.post(
    '/deposits',
    depositUpload.single('receipt'),
    depositController.analyzeReceiptUpload,
    createDepositValidation,
    validate,
    me.createDeposit
);

router.get('/deposits', me.getDeposits);
router.get(
    '/deposits/:id',
    [param('id').isMongoId().withMessage('Invalid deposit ID')],
    validate,
    me.getDeposit
);

module.exports = router;
