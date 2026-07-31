'use strict';

const { Decimal } = require('../shared/utils/decimalPrecision');

const toDecimal = (value) => new Decimal(value ?? 0);

const expectMoneyString = (value, expected) => {
    expect(typeof value).toBe('string');
    expect(toDecimal(value).equals(toDecimal(expected))).toBe(true);
};

const expectMoneyValue = (value, expected) => {
    expect(toDecimal(value).equals(toDecimal(expected))).toBe(true);
};

const expectFiatAmount = (value, expected, precision = 2) => {
    expect(Number(value)).toBeCloseTo(Number(expected), precision);
};

module.exports = {
    expectMoneyString,
    expectMoneyValue,
    expectFiatAmount,
};
