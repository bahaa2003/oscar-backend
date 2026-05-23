'use strict';

/**
 * currency.controller.js
 *
 * Admin HTTP adapter for currency management.
 *
 * Routes (mounted at /api/admin/currencies):
 *   GET    /                    → listCurrencies
 *   POST   /                    → createCurrency
 *   GET    /:code               → getCurrency
 *   PATCH  /:code               → updateRate
 *   PATCH  /:code/status        → setStatus
 */

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');
const currencyService = require('./currency.service');

// =============================================================================
// GET /admin/currencies
// =============================================================================

/**
 * List all currencies. Admin sees all; pass ?activeOnly=true for active only.
 */
const listCurrenciesHandler = catchAsync(async (req, res) => {
    const activeOnly = req.query.activeOnly === 'true';
    const currencies = await currencyService.listCurrencies({ activeOnly });
    sendSuccess(res, currencies, 'Currencies retrieved.');
});

// =============================================================================
// POST /admin/currencies
// =============================================================================

/**
 * Admin creates a currency manually (not from exchange feed).
 *
 * Body: { code, name, symbol, platformRate, marketRate?, markupPercentage? }
 */
const createCurrencyHandler = catchAsync(async (req, res) => {
    const { code, name, symbol, platformRate, marketRate, markupPercentage } = req.body;
    const currency = await currencyService.createCurrency({
        code, name, symbol, platformRate, marketRate, markupPercentage,
    });
    sendCreated(res, currency, `Currency '${currency.code}' created.`);
});

// =============================================================================
// GET /admin/currencies/:code
// =============================================================================

/**
 * Get a single currency by its ISO code.
 */
const getCurrencyHandler = catchAsync(async (req, res) => {
    const currency = await currencyService.getCurrencyByCode(req.params.code);
    sendSuccess(res, currency);
});

// =============================================================================
// PATCH /admin/currencies/:code
// =============================================================================

/**
 * Update the platformRate (and optionally markupPercentage / name / symbol).
 * If applyDebtAdjustment is true and rate increased, adjusts user debts.
 *
 * Body: { platformRate?, markupPercentage?, name?, symbol?, applyDebtAdjustment? }
 */
const updateRateHandler = catchAsync(async (req, res) => {
    const { platformRate, markupPercentage, name, symbol, applyDebtAdjustment } = req.body;
    const { currency, debtAdjustment } = await currencyService.updateCurrencyRate(req.params.code, {
        platformRate, markupPercentage, name, symbol,
        applyDebtAdjustment,
        adminId: req.user?._id,
    });

    const message = debtAdjustment?.usersAdjusted
        ? `Currency '${currency.code}' updated. Debt adjustment applied to ${debtAdjustment.usersAdjusted} users.`
        : `Currency '${currency.code}' updated.`;

    sendSuccess(res, { currency, debtAdjustment }, message);
});

// =============================================================================
// PATCH /admin/currencies/:code/status
// =============================================================================

/**
 * Enable or disable a currency.
 *
 * Body: { isActive: true | false }
 */
const setStatusHandler = catchAsync(async (req, res) => {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
        return res.status(400).json({
            success: false,
            code: 'VALIDATION_ERROR',
            message: '`isActive` must be a boolean (true or false).',
        });
    }
    const currency = await currencyService.setCurrencyStatus(req.params.code, isActive);
    sendSuccess(
        res,
        currency,
        `Currency '${currency.code}' ${isActive ? 'enabled' : 'disabled'}.`
    );
});

// =============================================================================
// DELETE /admin/currencies/:code
// =============================================================================

/**
 * Delete a currency if it is not linked to any user wallet.
 */
const deleteCurrencyHandler = catchAsync(async (req, res) => {
    const currency = await currencyService.deleteCurrency(req.params.code);
    sendSuccess(res, currency, `Currency '${currency.code}' deleted.`);
});

module.exports = {
    listCurrenciesHandler,
    createCurrencyHandler,
    getCurrencyHandler,
    updateRateHandler,
    setStatusHandler,
    deleteCurrencyHandler,
};
