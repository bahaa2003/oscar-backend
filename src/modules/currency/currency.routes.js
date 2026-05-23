'use strict';

/**
 * currency.routes.js
 *
 * Admin-only routes for currency management.
 * Mounted at: /api/admin/currencies
 *
 * Route map:
 *   GET    /                   → list all currencies
 *   POST   /                   → create a currency manually
 *   GET    /:code              → get a single currency
 *   PATCH  /:code              → update platformRate / markupPercentage
 *   PATCH  /:code/status       → enable / disable a currency
 */

const { Router } = require('express');
const  authenticate  = require('../../shared/middlewares/authenticate');
const  authorize  = require('../../shared/middlewares/authorize');
const {
    listCurrenciesHandler,
    createCurrencyHandler,
    getCurrencyHandler,
    updateRateHandler,
    setStatusHandler,
    deleteCurrencyHandler,
} = require('./currency.controller');

const router = Router();

// All currency admin routes require authentication + ADMIN role
router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/', listCurrenciesHandler);
router.post('/', createCurrencyHandler);
router.get('/:code', getCurrencyHandler);
router.patch('/:code/status', setStatusHandler);   // NOTE: /status BEFORE /:code to avoid param conflict
router.patch('/:code', updateRateHandler);
router.delete('/:code', deleteCurrencyHandler);

module.exports = router;
