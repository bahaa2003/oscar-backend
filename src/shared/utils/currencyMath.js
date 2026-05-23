'use strict';

/**
 * currencyMath.js — Pure currency conversion utilities.
 *
 * All functions use toFixed(2) rounding to avoid floating-point drift
 * in financial calculations.
 *
 * Rate convention:  1 USD = <platformRate> units of local currency.
 *   USD platformRate = 1
 *   EGP platformRate = 50  (1 USD = 50 EGP)
 *   SAR platformRate = 3.75
 */

/**
 * Convert a balance from one currency to another using their platform rates.
 *
 * Formula: newBalance = (currentBalance / oldRate) * newRate
 *
 * @param {number} balance - Current balance in old currency
 * @param {number} oldRate - platformRate of the old currency (e.g. 50 for EGP)
 * @param {number} newRate - platformRate of the new currency (e.g. 1 for USD)
 * @returns {number} Converted balance, rounded to 2 decimal places
 *
 * @example
 *   convertBalance(200, 50, 1)    // 200 EGP → 4.00 USD
 *   convertBalance(4, 1, 50)      // 4 USD   → 200.00 EGP
 *   convertBalance(200, 50, 3.75) // 200 EGP → 15.00 SAR
 */
const convertBalance = (balance, oldRate, newRate) => {
    if (oldRate <= 0 || newRate <= 0) {
        throw new Error('Currency rates must be positive numbers.');
    }
    const usdEquivalent = balance / oldRate;
    return parseFloat((usdEquivalent * newRate).toFixed(2));
};

/**
 * Convert a USD amount to a local currency amount.
 *
 * @param {number} usdAmount - Amount in USD
 * @param {number} rate      - platformRate of the target currency
 * @returns {number} Amount in local currency, rounded to 2 decimal places
 *
 * @example
 *   usdToLocal(10, 50)   // → 500.00 (10 USD = 500 EGP)
 *   usdToLocal(10, 1)    // → 10.00  (10 USD = 10 USD)
 */
const usdToLocal = (usdAmount, rate) => {
    return parseFloat((usdAmount * rate).toFixed(2));
};

/**
 * Convert a local currency amount back to USD.
 *
 * @param {number} localAmount - Amount in local currency
 * @param {number} rate        - platformRate of the source currency
 * @returns {number} Amount in USD, rounded to 6 decimal places (precision)
 *
 * @example
 *   localToUsd(500, 50)  // → 10.000000 (500 EGP = 10 USD)
 */
const localToUsd = (localAmount, rate) => {
    if (rate <= 0) {
        throw new Error('Currency rate must be a positive number.');
    }
    return parseFloat((localAmount / rate).toFixed(6));
};

module.exports = { convertBalance, usdToLocal, localToUsd };
