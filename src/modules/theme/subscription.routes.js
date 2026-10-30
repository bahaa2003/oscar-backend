'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { AppError } = require('../../shared/errors/AppError');
const service = require('./theme.service');
const { ThemePayment } = require('./subscription.model');

const router = Router();
router.use(authenticate, requireActiveUser);
router.get('/current', catchAsync(async (req, res) => {
    const state = await service.getStatus(req.user._id);
    return sendSuccess(res, { plan: service.plan, eligibility: state.eligibility,
        checkoutAvailable: false, paymentProvider: null });
}));
router.get('/payments', catchAsync(async (req, res) => {
    const items = await ThemePayment.find({ userId: req.user._id })
        .select('provider providerReference amountMinor currency status verifiedAt createdAt updatedAt')
        .sort({ createdAt: -1 }).limit(20).lean();
    return sendSuccess(res, { items });
}));
router.post('/checkout', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 }), (_req, _res, next) =>
    next(new AppError('Theme Pro checkout is unavailable until a verified payment provider is configured.',
        503, 'PAYMENT_PROVIDER_UNAVAILABLE')));
module.exports = router;
