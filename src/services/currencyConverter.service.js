'use strict';

/**
 * currencyConverter.service.js
 *
 * Stateless conversion utilities.
 *
 * All conversions use Currency.platformRate — never marketRate.
 * The platformRate is the single source of truth for all financial math.
 *
 * USD is the internal pricing unit for all products/providers.
 * This service converts between USD and any user-facing currency.
 *
 * Design:
 *  - Functions throw clear errors if the currency is missing or inactive.
 *  - Return objects carry the full context (rate, currency code, amounts)
 *    so callers can snapshot them directly into order documents.
 *  - USD → USD is a no-op (rate = 1, no DB hit needed).
 */

const { Currency } = require('../modules/currency/currency.model');
const { NotFoundError, BusinessRuleError } = require('../shared/errors/AppError');

// ─── Internal cache ───────────────────────────────────────────────────────────
// Very lightweight in-process cache with 60 s TTL.
// Prevents a DB hit on every single order line item without needing Redis.
// Cache is keyed by uppercase currency code.
const _cache = new Map();   // code → { doc, cachedAt }
const CACHE_TTL_MS = 60_000;

/**
 * Fetch a Currency document, with a simple 60-second in-process cache.
 * Returns null for USD without hitting the DB (rate is always 1).
 *
 * @param {string}   code     - ISO 4217 code (any case)
 * @param {boolean}  bypassCache - set true in tests
 * @returns {Promise<Object|null>}
 */
const _getCurrency = async (code, bypassCache = false) => {
    const upper = (code ?? '').toUpperCase().trim();
    if (!upper) throw new BusinessRuleError('Currency code is required.', 'MISSING_CURRENCY_CODE');

    // USD shortcut — rate is always 1
    if (upper === 'USD') return null;   // callers handle null → rate = 1

    if (!bypassCache) {
        const cached = _cache.get(upper);
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            return cached.doc;
        }
    }

    const doc = await Currency.findOne({ code: upper });
    if (!doc) throw new NotFoundError(`Currency '${upper}'`);
    if (!doc.isActive) {
        throw new BusinessRuleError(
            `Currency '${upper}' is currently inactive.`,
            'CURRENCY_INACTIVE'
        );
    }

    _cache.set(upper, { doc, cachedAt: Date.now() });
    return doc;
};

/**
 * Invalidate the in-process cache for a specific currency code.
 * Called by currency.service after an admin platformRate update.
 *
 * @param {string} code
 */
const invalidateCurrencyCache = (code) => {
    _cache.delete((code ?? '').toUpperCase().trim());
};

// =============================================================================
// convertUsdToUserCurrency
// =============================================================================

/**
 * Convert a USD amount to the user's local currency.
 *
 * @param {number} usdAmount      - Must be > 0
 * @param {string} userCurrency   - ISO 4217 code (e.g. "SAR", "EGP", "USD")
 * @returns {Promise<{
 *   usdAmount:    number,
 *   currency:     string,
 *   rate:         number,
 *   finalAmount:  number,
 * }>}
 *
 * Example:
 *   convertUsdToUserCurrency(10, "SAR")
 *   → { usdAmount: 10, currency: "SAR", rate: 4.1, finalAmount: 41 }
 */
const convertUsdToUserCurrency = async (usdAmount, userCurrency) => {
    if (typeof usdAmount !== 'number' || usdAmount < 0) {
        throw new BusinessRuleError('usdAmount must be a non-negative number.', 'INVALID_AMOUNT');
    }

    const currDoc = await _getCurrency(userCurrency);

    // USD → USD: pure passthrough
    if (!currDoc) {
        return {
            usdAmount,
            currency: 'USD',
            rate: 1,
            finalAmount: parseFloat(usdAmount.toFixed(6)),
        };
    }

    const rate = currDoc.platformRate;
    // Use 4dp to preserve sub-cent precision for micro-transactions
    // (e.g. $0.0002 × 15 SAR/USD = 0.003 SAR). Final wallet rounding
    // to 2dp is handled at the order.service.js chargedAmount step.
    const finalAmount = parseFloat((usdAmount * rate).toFixed(4));

    return {
        usdAmount,
        currency: currDoc.code,
        rate,
        finalAmount,
    };
};

// =============================================================================
// convertUserCurrencyToUsd
// =============================================================================

/**
 * Convert an amount in user currency back to USD.
 *
 * @param {number} amount        - Amount in user's currency
 * @param {string} userCurrency  - ISO 4217 code
 * @returns {Promise<{
 *   originalAmount: number,
 *   currency:       string,
 *   rate:           number,
 *   usdAmount:      number,
 * }>}
 */
const convertUserCurrencyToUsd = async (amount, userCurrency) => {
    if (typeof amount !== 'number' || amount < 0) {
        throw new BusinessRuleError('amount must be a non-negative number.', 'INVALID_AMOUNT');
    }

    const currDoc = await _getCurrency(userCurrency);

    if (!currDoc) {
        return {
            originalAmount: amount,
            currency: 'USD',
            rate: 1,
            usdAmount: parseFloat(amount.toFixed(2)),
        };
    }

    const rate = currDoc.platformRate;
    const usdAmount = parseFloat((amount / rate).toFixed(6));  // 6dp for USD precision

    return {
        originalAmount: amount,
        currency: currDoc.code,
        rate,
        usdAmount,
    };
};

// =============================================================================
// getConversionRate  (lightweight helper for order.service.js)
// =============================================================================

/**
 * Return just the platformRate for a currency code.
 * Returns 1 for USD without a DB hit.
 *
 * @param {string} currencyCode
 * @returns {Promise<number>}
 */
const getConversionRate = async (currencyCode) => {
    const currDoc = await _getCurrency(currencyCode);
    return currDoc ? currDoc.platformRate : 1;
};

module.exports = {
    convertUsdToUserCurrency,
    convertUserCurrencyToUsd,
    getConversionRate,
    invalidateCurrencyCache,
    // Exported for tests only
    _getCurrency,
};
