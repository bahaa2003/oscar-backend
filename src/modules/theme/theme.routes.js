'use strict';

const { Router } = require('express');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const service = require('./theme.service');

const router = Router();
// Consumers may only read the published platform appearance.
router.get('/published', catchAsync(async (_req, res) => sendSuccess(res, await service.published())));

module.exports = router;
