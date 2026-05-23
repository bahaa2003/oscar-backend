'use strict';

/**
 * currency.service.js
 *
 * Business logic for admin currency management.
 *
 * Responsibilities:
 *   - Seed / ensure the USD base currency exists on startup
 *   - List all currencies (with optional active-only filter)
 *   - Get a single currency by code
 *   - Admin: update platformRate and/or markupPercentage
 *   - Admin: enable / disable a currency
 *
 * All writes invalidate the in-process converter cache so the change
 * takes effect for the very next order without a server restart.
 */

const { Currency } = require('./currency.model');
const { User } = require('../users/user.model');
const { invalidateCurrencyCache } = require('../../services/currencyConverter.service');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../../shared/errors/AppError');

// =============================================================================
// SEED: Ensure USD base currency
// =============================================================================

/**
 * Idempotently create the USD base currency.
 * Should be called once from server.js after DB connects.
 *
 * @returns {Promise<void>}
 */
const seedBaseCurrency = async () => {
    const exists = await Currency.findOne({ code: 'USD' });
    if (!exists) {
        await Currency.create({
            code: 'USD',
            name: 'US Dollar',
            symbol: '$',
            marketRate: 1,
            platformRate: 1,
            markupPercentage: 0,
            isActive: true,
            lastUpdatedAt: new Date(),
        });
        console.log('[CurrencyService] USD base currency seeded.');
    }
};

// =============================================================================
// QUERY
// =============================================================================

/**
 * List all currencies.
 *
 * @param {Object} [filter]
 * @param {boolean} [filter.activeOnly]  - if true, only return isActive=true
 * @returns {Promise<Currency[]>}
 */
const listCurrencies = async ({ activeOnly = false } = {}) => {
    const query = activeOnly ? { isActive: true } : {};
    return Currency.find(query).sort({ code: 1 });
};

/**
 * Get a single currency by its ISO code.
 *
 * @param {string} code  - ISO 4217 code (any case)
 * @returns {Promise<Currency>}
 */
const getCurrencyByCode = async (code) => {
    const upper = (code ?? '').toUpperCase().trim();
    const doc = await Currency.findOne({ code: upper });
    if (!doc) throw new NotFoundError(`Currency '${upper}'`);
    return doc;
};

// =============================================================================
// ADMIN: UPDATE PLATFORM RATE
// =============================================================================

/**
 * Admin updates the platformRate (and optionally markupPercentage) for a currency.
 *
 * Rules:
 *   - USD platformRate is always 1. Attempts to set it to anything else throw.
 *   - platformRate must be > 0.
 *   - Updates invalidate the in-process converter cache immediately.
 *   - If applyDebtAdjustment is true and the rate changed, automatically
 *     adjusts all negative user balances by the percentage increase.
 *
 * @param {string} code           - ISO 4217 code
 * @param {Object} updates
 * @param {number}  [updates.platformRate]          - new billing rate
 * @param {number}  [updates.markupPercentage]      - optional markup (informational)
 * @param {string}  [updates.name]                  - display name override
 * @param {string}  [updates.symbol]                - symbol override
 * @param {boolean} [updates.applyDebtAdjustment]   - opt-in to debt pegging
 * @param {string}  [updates.adminId]               - admin ObjectId (required if applyDebtAdjustment)
 * @returns {Promise<{ currency: Currency, debtAdjustment: Object|null }>}
 */
const updateCurrencyRate = async (code, updates) => {
    const upper = (code ?? '').toUpperCase().trim();
    const doc = await Currency.findOne({ code: upper });
    if (!doc) throw new NotFoundError(`Currency '${upper}'`);

    const { platformRate, markupPercentage, name, symbol, applyDebtAdjustment, adminId } = updates;

    // Capture old rate BEFORE mutation (needed for percentage calc)
    const oldRate = doc.platformRate;

    // Guard: USD rate is always 1
    if (upper === 'USD' && platformRate !== undefined && platformRate !== 1) {
        throw new BusinessRuleError(
            'The USD platform rate must always be exactly 1.',
            'IMMUTABLE_USD_RATE'
        );
    }

    if (platformRate !== undefined) {
        if (typeof platformRate !== 'number' || platformRate <= 0) {
            throw new BusinessRuleError(
                'platformRate must be a positive number.',
                'INVALID_PLATFORM_RATE'
            );
        }
        doc.platformRate = parseFloat(platformRate.toFixed(6));
    }

    if (markupPercentage !== undefined) {
        if (typeof markupPercentage !== 'number' || markupPercentage < 0) {
            throw new BusinessRuleError(
                'markupPercentage must be a non-negative number.',
                'INVALID_MARKUP'
            );
        }
        doc.markupPercentage = markupPercentage;
    }

    if (name !== undefined) doc.name = name;
    if (symbol !== undefined) doc.symbol = symbol;

    doc.lastUpdatedAt = new Date();
    await doc.save();

    invalidateCurrencyCache(upper);

    // Strictly cast to Number to prevent string comparison bugs
    const newRate = Number(doc.platformRate);
    const oldRateNum = Number(oldRate);

    // ── Debt Adjustment: if rate changed and admin opted in ───────────────
    // Bi-directional: rate UP → debts increase (inflation pegging)
    //                 rate DOWN → debts decrease (deflation relief)
    let debtAdjustmentResult = null;
    if (
        applyDebtAdjustment &&
        platformRate !== undefined &&
        newRate !== oldRateNum &&
        oldRateNum > 0
    ) {
        const percentageChange = Math.abs(((newRate - oldRateNum) / oldRateNum) * 100);
        const isIncrease = newRate > oldRateNum;
        try {
            const { adjustNegativeBalancesForInflation, adjustNegativeBalancesForDeflation } = require('../admin/admin.wallet.service');

            if (isIncrease) {
                // Rate went UP → debts grow (more negative)
                debtAdjustmentResult = await adjustNegativeBalancesForInflation(
                    parseFloat(percentageChange.toFixed(4)),
                    adminId,
                    upper
                );
            } else {
                // Rate went DOWN → debts shrink (less negative) — relief
                debtAdjustmentResult = await adjustNegativeBalancesForDeflation(
                    parseFloat(percentageChange.toFixed(4)),
                    adminId,
                    upper
                );
            }
        } catch (err) {
            console.error(`[CurrencyService] Debt adjustment FAILED for ${upper}:`, err.message);
            debtAdjustmentResult = { error: err.message, usersAdjusted: 0 };
        }
    }

    return { currency: doc, debtAdjustment: debtAdjustmentResult };
};

// =============================================================================
// ADMIN: TOGGLE STATUS
// =============================================================================

/**
 * Enable or disable a currency.
 *
 * USD cannot be disabled — it is the platform base currency.
 *
 * @param {string}  code
 * @param {boolean} isActive
 * @returns {Promise<Currency>}
 */
const setCurrencyStatus = async (code, isActive) => {
    const upper = (code ?? '').toUpperCase().trim();

    if (upper === 'USD' && !isActive) {
        throw new BusinessRuleError(
            'The USD base currency cannot be disabled.',
            'CANNOT_DISABLE_USD'
        );
    }

    const doc = await Currency.findOne({ code: upper });
    if (!doc) throw new NotFoundError(`Currency '${upper}'`);

    doc.isActive = Boolean(isActive);
    doc.lastUpdatedAt = new Date();
    await doc.save();

    invalidateCurrencyCache(upper);
    console.log(`[CurrencyService] ${upper} ${isActive ? 'enabled' : 'disabled'}.`);

    return doc;
};

// =============================================================================
// ADMIN: CREATE CURRENCY MANUALLY
// =============================================================================

/**
 * Admin creates a currency that wasn't auto-discovered from the exchange feed.
 *
 * @param {Object} data
 * @returns {Promise<Currency>}
 */
const createCurrency = async ({ code, name, symbol, platformRate, marketRate, markupPercentage }) => {
    const upper = (code ?? '').toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(upper)) {
        throw new BusinessRuleError(
            'Currency code must be a 3-letter ISO 4217 code.',
            'INVALID_CURRENCY_CODE'
        );
    }

    const existing = await Currency.findOne({ code: upper });
    if (existing) {
        throw new ConflictError(`Currency '${upper}' already exists.`);
    }

    const doc = await Currency.create({
        code: upper,
        name,
        symbol,
        marketRate: marketRate ?? null,
        platformRate: parseFloat((platformRate || 1).toFixed(6)),
        markupPercentage: markupPercentage ?? 0,
        isActive: true,
        lastUpdatedAt: new Date(),
    });

    return doc;
};

// =============================================================================
// ADMIN: DELETE CURRENCY
// =============================================================================

/**
 * Delete a currency when it is not linked to any user wallet.
 *
 * Users currently store currency as the ISO code, while some older data may
 * still contain the currency document id as a string. Check both forms so an
 * unused currency is not blocked by a malformed existence query.
 *
 * @param {string} codeOrId
 * @returns {Promise<Currency>}
 */
const deleteCurrency = async (codeOrId) => {
    const key = String(codeOrId || '').trim();
    const upper = key.toUpperCase();
    const doc = /^[a-f\d]{24}$/i.test(key)
        ? await Currency.findById(key)
        : await Currency.findOne({ code: upper });

    if (!doc) throw new NotFoundError(`Currency '${upper}'`);

    if (doc.code === 'USD') {
        throw new BusinessRuleError(
            'The USD base currency cannot be deleted.',
            'CANNOT_DELETE_USD'
        );
    }

    const linkedUser = await User.exists({
        currency: { $in: [doc.code, String(doc._id), doc._id] },
    });

    if (linkedUser) {
        throw new BusinessRuleError(
            'Cannot delete currency in use',
            'CURRENCY_IN_USE'
        );
    }

    await doc.deleteOne();
    invalidateCurrencyCache(doc.code);

    return doc;
};

module.exports = {
    seedBaseCurrency,
    listCurrencies,
    getCurrencyByCode,
    updateCurrencyRate,
    setCurrencyStatus,
    createCurrency,
    deleteCurrency,
};
