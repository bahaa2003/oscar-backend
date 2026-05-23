'use strict';

const { Router } = require('express');
const depositController = require('./deposit.controller');
const {
    createDepositValidation,
    approveDepositValidation,
    rejectDepositValidation,
    listDepositsValidation,
} = require('./deposit.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { createUpload } = require('../../shared/middlewares/upload');

const depositUpload = createUpload('deposits');

const router = Router();

// All deposit routes require a valid JWT
router.use(authenticate);

// ─── Customer Routes ──────────────────────────────────────────────────────────

/**
 * @route  POST /api/deposits
 * @desc   Customer submits a new deposit request with receipt upload
 * @access Authenticated ACTIVE user
 * @body   multipart/form-data: receipt (file), requestedAmount, currency, paymentMethodId, notes?
 */
router.post(
    '/',
    requireActiveUser,
    depositUpload.single('receipt'),
    depositController.analyzeReceiptUpload,
    createDepositValidation, validate,
    depositController.createDeposit
);

/**
 * @route  GET /api/deposits
 * @desc   Admin: all deposits (filterable). Customer: own deposits.
 * @access Authenticated
 * @query  status, page, limit
 */
router.get(
    '/',
    listDepositsValidation, validate,
    depositController.listDeposits
);

// ─── Admin Routes ─────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/deposits/:id/approve
 * @desc   Admin approves a deposit and credits the user's wallet with amountUsd
 * @access Admin only
 */
router.patch(
    '/:id/approve',
    authorize('ADMIN', 'SUPERVISOR'),
    requirePermission('MANAGE_DEPOSITS'),
    approveDepositValidation, validate,
    depositController.approveDeposit
);

/**
 * @route  PATCH /api/deposits/:id/reject
 * @desc   Admin rejects a deposit request
 * @access Admin only
 */
router.patch(
    '/:id/reject',
    authorize('ADMIN', 'SUPERVISOR'),
    requirePermission('MANAGE_DEPOSITS'),
    rejectDepositValidation, validate,
    depositController.rejectDeposit
);

module.exports = router;
