'use strict';

const { Router } = require('express');
const { requirePaymentProvider } = require('./payment.provider');

const router = Router();
// No electronic checkout provider exists in this deployment. An incoming
// request must never be accepted as proof of payment.
router.post('/webhook', (_req, _res, next) => {
    try { requirePaymentProvider(); } catch (error) { return next(error); }
    return next();
});
module.exports = router;
