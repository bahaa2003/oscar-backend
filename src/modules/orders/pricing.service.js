'use strict';

/**
 * pricing.service.js — Pure Pricing Engine (Arbitrary Precision)
 * ──────────────────────────────────────────────────────────────
 * All functions here are pure where possible (no side effects, no DB).
 * calculateUserPrice is the only one that touches the DB.
 *
 * Single source of truth for markup math — used by order.service.js
 * at order creation time to produce the price snapshots burned into
 * each Order document.
 *
 * Prices are STRING throughout (up to 50 dp). Only chargedAmount is
 * a 2 dp Number because wallet balances are standard fiat.
 */

const { BusinessRuleError } = require('../../shared/errors/AppError');
const { Decimal, toDecimal, isPositive, multiply, divide, add } = require('../../shared/utils/decimalPrecision');
const { resolveEffectivePricingContext } = require('../pricing/commercialPricing.service');

const isValidDecimalInput = (value) => {
    if (value === null || value === undefined || value === '') return false;
    try {
        const decimal = new Decimal(value);
        return decimal.isFinite();
    } catch {
        return false;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the final price after applying a group markup percentage.
 *
 * Rules:
 *  - basePrice must be >= 0 (string or number)
 *  - percentage must be >= 0
 *  - finalPrice = basePrice + (basePrice × percentage / 100)
 *
 * @param {string|number} basePrice   - Raw product price (>= 0)
 * @param {number}        percentage  - Group markup percentage (>= 0)
 * @returns {string} finalPrice as an arbitrary-precision string
 * @throws {BusinessRuleError} if inputs are invalid
 */
const calculateFinalPrice = (basePrice, percentage) => {
    if (!isValidDecimalInput(basePrice)) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }

    const base = toDecimal(basePrice);
    if (base.isNegative()) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    if (typeof percentage !== 'number') {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct < 0) {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    // basePrice + basePrice * (percentage / 100)
    const markup = multiply(basePrice, divide(String(pct), '100'));
    return add(basePrice, markup);
};

// ─────────────────────────────────────────────────────────────────────────────
// DB-BACKED CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the effective price for a specific user by looking up their
 * group's markup percentage, then applying calculateFinalPrice.
 *
 * @param {string|ObjectId} userId    - The buying user's ID
 * @param {string|number}   basePrice - Product's base price
 * @param {Object}          [session] - Optional Mongoose session (for transactions)
 * @returns {Promise<{
 *   basePrice:        string,
 *   markupPercentage: number,
 *   finalPrice:       string,
 *   groupId:          ObjectId
 * }>}
 */
const calculateUserPrice = async (userId, basePrice, session = null) => {
    const pricingContext = await resolveEffectivePricingContext(userId, { session });

    if (pricingContext.pricingEligibility?.reason === 'DEFAULT_GROUP_FALLBACK') {
        throw new BusinessRuleError(
            'User is not assigned to any pricing group. Contact an administrator.',
            'NO_GROUP_ASSIGNED'
        );
    }

    // percentage stays as Number — it's a simple integer (e.g. 20 = 20%)
    const markupPercentage = Number.isFinite(Number(pricingContext.effectiveGroup.percentage))
        ? Number(pricingContext.effectiveGroup.percentage)
        : 0;

    // basePrice is a string — ensure it's valid
    const safeBasePrice = isPositive(basePrice) ? String(basePrice) : '0';

    const finalPrice = calculateFinalPrice(safeBasePrice, markupPercentage);

    return {
        basePrice: safeBasePrice,
        markupPercentage,
        finalPrice,
        groupId: pricingContext.effectiveGroup.id,
        pricingContext,
    };
};

module.exports = { calculateFinalPrice, calculateUserPrice };
