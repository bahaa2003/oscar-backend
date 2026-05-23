'use strict';

const { Router } = require('express');
const targetCtrl = require('./target.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { createUpload } = require('../../shared/middlewares/upload');
const { validateBody, validateQuery, schemas } = require('./target.validation');

const targetUpload = createUpload('targets');

const router = Router();

router.use(authenticate, requireActiveUser);

router.get('/apps', targetCtrl.getActiveTargetApps);

router.post(
    '/',
    targetUpload.single('screenshotProof'),
    validateBody(schemas.createTargetOrder),
    targetCtrl.createTargetOrder
);

router.get(
    '/',
    validateQuery(schemas.listMyTargetOrders),
    targetCtrl.getMyTargetOrders
);

module.exports = router;
