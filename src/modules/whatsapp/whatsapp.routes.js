'use strict';

const express = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');
const catchAsync = require('../../shared/utils/catchAsync');
const whatsappController = require('./whatsapp.controller');

const router = express.Router();

router.use(authenticate);
router.use(authorize('ADMIN', 'SUPERVISOR'));
router.use(requirePermission('MANAGE_SETTINGS'));

router.get('/status', catchAsync(whatsappController.getStatus));
router.post('/reconnect', catchAsync(whatsappController.reconnect));

module.exports = router;
