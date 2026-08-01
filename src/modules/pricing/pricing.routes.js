'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const requireProfileComplete = require('../../shared/middlewares/requireProfileComplete');
const validate = require('../../shared/middlewares/validate');
const pricingController = require('./pricing.controller');
const { quoteValidation } = require('./pricing.validation');

const router = Router();

router.use(authenticate);

router.post(
    '/me/quote',
    requireActiveUser,
    requireProfileComplete,
    quoteValidation,
    validate,
    pricingController.quoteForCurrentUser
);

module.exports = router;
