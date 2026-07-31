'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const controller = require('./resellerApplication.controller');
const { validateBody, validateQuery, schemas } = require('./resellerApplication.validation');

const router = Router();

router.use(authenticate, requireActiveUser);

router.post('/me', validateBody(schemas.submitApplication), controller.submitMine);
router.get('/me/current', controller.getMyCurrent);
router.get('/me/history', validateQuery(schemas.historyQuery), controller.listMyHistory);

module.exports = router;
