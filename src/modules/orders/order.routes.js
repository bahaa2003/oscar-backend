'use strict';

const { Router } = require('express');
const orderController = require('./order.controller');
const { createOrderValidation, orderIdParamValidation } = require('./order.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');

const router = Router();

// All order routes require authentication
router.use(authenticate);

// ── Customer Routes ───────────────────────────────────────────────────────────

/**
 * @route  POST /api/orders
 * @desc   Place a new order
 * @access Active Customer only
 */
router.post('/', requireActiveUser, authorize('CUSTOMER'), createOrderValidation, validate, orderController.createOrder);

/**
 * @route  GET /api/orders/my
 * @desc   Get current user's orders
 * @access Active Customer only
 */
router.get('/my', requireActiveUser, authorize('CUSTOMER'), orderController.getMyOrders);

/**
 * @route  GET /api/orders/my/:id
 * @desc   Get a specific order belonging to the current user
 * @access Active Customer only
 */
router.get('/my/:id', requireActiveUser, authorize('CUSTOMER'), orderIdParamValidation, validate, orderController.getMyOrder);

// ── Admin Routes ──────────────────────────────────────────────────────────────

/**
 * @route  GET /api/orders
 * @desc   List all orders (with optional status filter)
 * @access Admin
 */
router.get('/', authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_ORDERS'), orderController.getAllOrders);

/**
 * @route  GET /api/orders/:id
 * @desc   Get any order by ID
 * @access Admin
 */
router.get('/:id', authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_ORDERS'), orderIdParamValidation, validate, orderController.adminGetOrder);

/**
 * @route  PATCH /api/orders/:id/fail
 * @desc   Mark order as failed and issue refund
 * @access Admin
 */
router.patch('/:id/fail', authorize('ADMIN', 'SUPERVISOR'), requirePermission('CONFIRM_ORDERS'), orderIdParamValidation, validate, orderController.failOrder);

/**
 * @route  PATCH /api/orders/:id/complete
 * @desc   Mark order as completed
 * @access Admin
 */
router.patch('/:id/complete', authorize('ADMIN', 'SUPERVISOR'), requirePermission('CONFIRM_ORDERS'), orderIdParamValidation, validate, orderController.completeOrder);

module.exports = router;
