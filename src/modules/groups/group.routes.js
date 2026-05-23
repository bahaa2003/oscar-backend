'use strict';

const { Router } = require('express');
const groupController = require('./group.controller');
const {
    createGroupValidation,
    updatePercentageValidation,
    updateGroupValidation,
    changeUserGroupValidation,
} = require('./group.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');

const router = Router();

// All group routes require authentication + ADMIN role
router.use(authenticate, authorize('ADMIN', 'SUPERVISOR'));

// ─── Group CRUD ───────────────────────────────────────────────────────────────

/**
 * @route  POST /api/groups
 * @desc   Create a pricing group
 * @access Admin
 */
router.post(
    '/',
    requirePermission('MANAGE_GROUPS'),
    createGroupValidation, validate,
    groupController.createGroup
);

/**
 * @route  GET /api/groups
 * @desc   List all groups (sorted by percentage desc)
 * @access Admin
 */
router.get('/', groupController.listGroups);

/**
 * @route  GET /api/groups/:id
 * @desc   Get a single group by ID
 * @access Admin
 */
router.get('/:id', groupController.getGroup);

/**
 * @route  PATCH /api/groups/:id
 * @desc   Update group name, percentage, or active status
 * @access Admin
 */
router.patch(
    '/:id',
    requirePermission('MANAGE_GROUPS'),
    updateGroupValidation, validate,
    groupController.updateGroup
);

/**
 * @route  PATCH /api/groups/:id/percentage
 * @desc   Update only the markup percentage of a group
 *         (forward-only — no retroactive effect on existing orders)
 * @access Admin
 */
router.patch(
    '/:id/percentage',
    requirePermission('MANAGE_GROUPS'),
    updatePercentageValidation, validate,
    groupController.updateGroupPercentage
);

// ─── User–Group Assignment ────────────────────────────────────────────────────

/**
 * @route  PATCH /api/groups/users/:userId
 * @desc   Move a customer to a different pricing group
 * @access Admin
 */
router.patch(
    '/users/:userId',
    requirePermission('MANAGE_GROUPS'),
    changeUserGroupValidation, validate,
    groupController.changeUserGroup
);

module.exports = router;
