'use strict';

const { Router } = require('express');
const auditController = require('./audit.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');

const router = Router();

// All audit routes: authenticated + ADMIN only
router.use(authenticate, authorize('ADMIN'));

/**
 * @route  GET /api/audit/entity/:type/:id
 * @desc   Paginated audit timeline for a specific entity
 *         type = USER | ORDER | WALLET | GROUP | SYSTEM
 * @access Admin
 * @query  page, limit
 */
router.get('/entity/:type/:id', auditController.getEntityLogs);

/**
 * @route  GET /api/audit/actor/:id
 * @desc   Paginated audit history for a specific actor (admin or customer)
 * @access Admin
 * @query  page, limit
 */
router.get('/actor/:id', auditController.getActorLogs);

module.exports = router;
