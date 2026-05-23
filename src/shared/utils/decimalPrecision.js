'use strict';

/**
 * decimalPrecision.js
 *
 * Arbitrary-precision arithmetic for the SMM pricing pipeline.
 *
 * ALL product prices (basePrice, providerPrice, finalPrice, rawPrice,
 * manualPriceAdjustment) are stored as **String** in MongoDB and flow
 * through the backend as strings. This module wraps `decimal.js` so
 * that every calculation preserves up to 50 decimal places.
 *
 * Wallet-facing amounts (chargedAmount, walletDeducted) are still
 * standard 2 dp Numbers because fiat currency doesn't need 50 dp.
 */

const Decimal = require('decimal.js');

// 60 significant-digit internal precision keeps 50 dp safe even after
// multi-step multiply / divide chains.
Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

/** How many decimal places we preserve for stored prices. */
const PRICE_DP = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely convert any value to a Decimal.
 * Handles null / undefined / NaN / empty-string gracefully.
 */
const toDecimal = (value) => {
    try {
        if (value === null || value === undefined || value === '') return new Decimal(0);
        return new Decimal(value);
    } catch {
        return new Decimal(0);
    }
};

/** String result, trimmed to PRICE_DP. */
const toStr = (d) => d.toDecimalPlaces(PRICE_DP).toFixed(PRICE_DP).replace(/\.?0+$/, '') || '0';

// ─── Arithmetic (all return String) ───────────────────────────────────────────

const add      = (a, b) => toStr(toDecimal(a).plus(toDecimal(b)));
const subtract = (a, b) => toStr(toDecimal(a).minus(toDecimal(b)));
const multiply = (a, b) => toStr(toDecimal(a).times(toDecimal(b)));
const divide   = (a, b) => {
    const divisor = toDecimal(b);
    if (divisor.isZero()) return '0';
    return toStr(toDecimal(a).dividedBy(divisor));
};

// ─── Comparisons ──────────────────────────────────────────────────────────────

const isPositive = (value) => toDecimal(value).greaterThan(0);
const isZero     = (value) => toDecimal(value).isZero();
const compare    = (a, b) => toDecimal(a).comparedTo(toDecimal(b)); // -1 | 0 | 1
const max        = (a, b) => toStr(Decimal.max(toDecimal(a), toDecimal(b)));

// ─── Domain helpers ───────────────────────────────────────────────────────────

/**
 * Round to 2 dp for fiat currency amounts (chargedAmount, walletDeducted).
 * Returns a Number — the only place in the pricing pipeline that does so.
 */
const toFiat = (value) => Number(toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber());

/**
 * Compute the final price after applying a markup to the provider cost.
 *
 *   percentage → providerPrice × (1 + markupValue / 100)
 *   fixed      → providerPrice + markupValue
 *
 * @param {string|number} providerPrice
 * @param {'percentage'|'fixed'} markupType
 * @param {string|number} markupValue
 * @returns {string|null}   null when providerPrice is invalid / negative
 */
const computeMarkup = (providerPrice, markupType, markupValue) => {
    const base = toDecimal(providerPrice);
    if (base.isNegative()) return null;

    const mv = toDecimal(markupValue);

    if (markupType === 'fixed') {
        return toStr(base.plus(mv));
    }
    // default: percentage
    return toStr(base.times(toDecimal(1).plus(mv.dividedBy(100))));
};

module.exports = {
    Decimal,
    toDecimal,
    PRICE_DP,
    toStr,
    add,
    subtract,
    multiply,
    divide,
    isPositive,
    isZero,
    compare,
    max,
    toFiat,
    computeMarkup,
};
