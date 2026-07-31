'use strict';

const mongoose = require('mongoose');
const { Product } = require('../products/product.model');
const { User, USER_STATUS, RESELLER_STATUS } = require('../users/user.model');
const Group = require('../groups/group.model');
const { getDefaultGroup } = require('../groups/group.service');
const { getConversionRate } = require('../../services/currencyConverter.service');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const {
    Decimal,
    toDecimal,
    toStr,
    toFiat,
    multiply,
    subtract,
    compare,
} = require('../../shared/utils/decimalPrecision');

const RESELLER_PRICING_CALCULATION_VERSION = 'reseller-pricing-v1';
const PRICING_TYPES = Object.freeze({
    DEFAULT: 'DEFAULT',
    GROUP: 'GROUP',
    RESELLER: 'RESELLER',
    QUANTITY_ONLY: 'QUANTITY_ONLY',
});

const PRICE_TAMPERING_FIELDS = Object.freeze([
    'unitPrice',
    'basePrice',
    'finalUnitPrice',
    'lineTotal',
    'subtotal',
    'total',
    'totalPrice',
    'priceCoins',
    'chargedAmount',
    'groupId',
    'percentage',
    'markupPercentage',
    'resellerStatus',
    'exchangeRate',
    'rateSnapshot',
    'userId',
]);

const normalizeObjectIdString = (value) => String(value || '').trim();

const sessionOption = (session) => (session ? { session } : {});

const assertObjectId = (value, code = 'INVALID_OBJECT_ID') => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new BusinessRuleError('Invalid identifier.', code);
    }
};

const assertSupportedCurrency = (currency) => {
    const code = String(currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
        throw new BusinessRuleError('Unsupported currency.', 'UNSUPPORTED_CURRENCY');
    }
    return code;
};

const assertDecimal = (value, code, message, { allowZero = true } = {}) => {
    try {
        const decimal = new Decimal(value);
        if (!decimal.isFinite() || decimal.isNegative() || (!allowZero && decimal.isZero())) {
            throw new Error('invalid');
        }
        return decimal;
    } catch {
        throw new BusinessRuleError(message, code);
    }
};

const decimalToCanonicalString = (value) => toStr(toDecimal(value));

const calculateFinalUnitPrice = (basePrice, percentage) => {
    const base = assertDecimal(basePrice, 'INVALID_BASE_PRICE', 'Base price must be a non-negative decimal.');
    const pct = assertDecimal(percentage, 'INVALID_PERCENTAGE', 'Group percentage must be a non-negative decimal.');
    const adjustment = base.times(pct).dividedBy(100);
    const final = base.plus(adjustment);
    if (final.isNegative()) {
        throw new BusinessRuleError('Calculated price cannot be negative.', 'NEGATIVE_RESULTING_PRICE');
    }
    return {
        baseUnitPrice: decimalToCanonicalString(base),
        groupPercentage: decimalToCanonicalString(pct),
        adjustmentAmount: decimalToCanonicalString(adjustment),
        finalUnitPrice: decimalToCanonicalString(final),
    };
};

const isGroupUsable = (group) => Boolean(group && group.isActive !== false && !group.deletedAt);

const loadDefaultGroup = async (session = null) => {
    const group = await getDefaultGroup();
    if (!session) return group;
    return Group.findById(group._id).session(session);
};

const loadUserForPricing = async (userId, session = null) => {
    assertObjectId(userId, 'INVALID_USER_ID');
    const query = User.findById(userId)
        .select('+resellerApprovedBy name email status deletedAt groupId resellerStatus resellerGroupId currency');
    if (session) query.session(session);
    const user = await query;
    if (!user) throw new NotFoundError('User');
    if (user.status !== USER_STATUS.ACTIVE || user.deletedAt) {
        throw new BusinessRuleError('User is not active for pricing.', 'ACCOUNT_INACTIVE');
    }
    return user;
};

const buildPricingContext = ({ user, group, pricingType, eligible, reason }) => ({
    userId: user._id,
    resellerStatus: user.resellerStatus || RESELLER_STATUS.NONE,
    userGroupId: user.groupId || null,
    effectiveGroup: {
        id: group?._id || null,
        name: group?.name || null,
        percentage: decimalToCanonicalString(group?.percentage ?? 0),
        isDefault: Boolean(group?.isDefault),
        billingMode: group?.billingMode || 'standard',
    },
    pricingEligibility: { eligible: Boolean(eligible), reason },
    pricingType,
    calculationVersion: RESELLER_PRICING_CALCULATION_VERSION,
});

const resolveEffectivePricingContext = async (userId, options = {}) => {
    const session = options.session || null;
    const user = options.user || await loadUserForPricing(userId, session);

    const currentGroup = user.groupId
        ? await Group.findById(user.groupId).session(session)
        : null;

    if (user.resellerStatus === RESELLER_STATUS.APPROVED) {
        if (!user.resellerGroupId) {
            throw new BusinessRuleError('Approved reseller is missing an assigned reseller group.', 'PRICING_RECONCILIATION_REQUIRED');
        }
        if (!user.groupId || normalizeObjectIdString(user.groupId) !== normalizeObjectIdString(user.resellerGroupId)) {
            throw new BusinessRuleError('Approved reseller group assignment is inconsistent.', 'PRICING_RECONCILIATION_REQUIRED');
        }
        if (!isGroupUsable(currentGroup)) {
            throw new BusinessRuleError('Approved reseller group is inactive, deleted, or missing.', 'PRICING_RECONCILIATION_REQUIRED');
        }
        return buildPricingContext({
            user,
            group: currentGroup,
            pricingType: currentGroup.billingMode === 'quantity_only' ? PRICING_TYPES.QUANTITY_ONLY : PRICING_TYPES.RESELLER,
            eligible: true,
            reason: 'APPROVED_RESELLER_VALID_GROUP',
        });
    }

    if (isGroupUsable(currentGroup)) {
        return buildPricingContext({
            user,
            group: currentGroup,
            pricingType: currentGroup.billingMode === 'quantity_only' ? PRICING_TYPES.QUANTITY_ONLY : PRICING_TYPES.GROUP,
            eligible: false,
            reason: user.resellerStatus === RESELLER_STATUS.SUSPENDED ? 'SUSPENDED_RESELLER_CURRENT_GROUP' : 'STANDARD_GROUP',
        });
    }

    if (currentGroup && currentGroup.deletedAt) {
        throw new BusinessRuleError('User pricing group is deleted.', 'GROUP_DELETED');
    }

    if (currentGroup && currentGroup.isActive === false) {
        throw new BusinessRuleError(`User's pricing group '${currentGroup.name}' is inactive. Contact an administrator.`, 'GROUP_INACTIVE');
    }

    const defaultGroup = await loadDefaultGroup(session);
    return buildPricingContext({
        user,
        group: defaultGroup,
        pricingType: defaultGroup.billingMode === 'quantity_only' ? PRICING_TYPES.QUANTITY_ONLY : PRICING_TYPES.DEFAULT,
        eligible: false,
        reason: user.resellerStatus === RESELLER_STATUS.SUSPENDED ? 'SUSPENDED_RESELLER_DEFAULT_GROUP' : 'DEFAULT_GROUP_FALLBACK',
    });
};

const assertProductForPricing = (product) => {
    if (!product) throw new NotFoundError('Product');
    if (product.isActive === false || product.deletedAt) {
        throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
    }
    assertDecimal(product.basePrice, 'INVALID_BASE_PRICE', 'Product base price is invalid.', { allowZero: false });
};

const validateQuantity = (product, quantity) => {
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
        throw new BusinessRuleError('Quantity must be a positive integer.', 'INVALID_QUANTITY');
    }
    if (product && (qty < product.minQty || qty > product.maxQty)) {
        throw new BusinessRuleError(`Quantity must be between ${product.minQty} and ${product.maxQty}.`, 'QUANTITY_OUT_OF_RANGE');
    }
    return qty;
};

const calculateProductPrice = ({ product, pricingContext, quantity = 1, currency = 'USD', exchangeRate = 1 }) => {
    assertProductForPricing(product);
    const qty = validateQuantity(product, quantity);
    const currencyCode = assertSupportedCurrency(currency);
    const rate = assertDecimal(exchangeRate, 'INVALID_EXCHANGE_RATE', 'Exchange rate must be positive.', { allowZero: false });
    const price = calculateFinalUnitPrice(product.basePrice, pricingContext?.effectiveGroup?.percentage ?? 0);
    const lineTotalUsd = multiply(price.finalUnitPrice, String(qty));
    const convertedLineTotal = toFiat(toDecimal(lineTotalUsd).times(rate));
    if (compare(lineTotalUsd, '0') <= 0 || convertedLineTotal <= 0) {
        throw new BusinessRuleError('Calculated price must be positive.', 'INVALID_PRICE_CALCULATION');
    }

    return {
        productId: product._id,
        productName: product.name,
        quantity: qty,
        currency: currencyCode,
        exchangeRate: Number(rate.toString()),
        ...price,
        lineTotalUsd,
        lineTotal: String(convertedLineTotal),
        calculationVersion: RESELLER_PRICING_CALCULATION_VERSION,
    };
};

const assertNoPriceTampering = (payload = {}) => {
    const locations = [];
    for (const field of PRICE_TAMPERING_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(payload, field)) locations.push(field);
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    items.forEach((item, index) => {
        for (const field of PRICE_TAMPERING_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(item || {}, field)) {
                locations.push(`items.${index}.${field}`);
            }
        }
    });
    if (locations.length > 0) {
        throw new BusinessRuleError('Client-supplied pricing fields are not accepted.', 'PRICE_TAMPERING_DETECTED');
    }
};

const calculateOrderPricing = async ({ userId, items, currency = null, session = null, rejectClientPricing = true }) => {
    const payload = { items: Array.isArray(items) ? items : [] };
    if (rejectClientPricing) assertNoPriceTampering(payload);
    if (!payload.items.length) {
        throw new BusinessRuleError('At least one item is required.', 'EMPTY_PRICING_QUOTE');
    }

    const user = await loadUserForPricing(userId, session);
    const pricingContext = await resolveEffectivePricingContext(userId, { user, session });
    const orderCurrency = assertSupportedCurrency(currency || user.currency || 'USD');
    const exchangeRate = await getConversionRate(orderCurrency, { session, bypassCache: Boolean(session) });
    assertDecimal(exchangeRate, 'INVALID_EXCHANGE_RATE', 'Exchange rate must be positive.', { allowZero: false });

    const calculatedItems = [];
    for (const item of payload.items) {
        assertObjectId(item?.productId, 'INVALID_PRODUCT_ID');
        const product = await Product.findById(item.productId).session(session);
        const pricing = calculateProductPrice({
            product,
            pricingContext,
            quantity: item.quantity,
            currency: orderCurrency,
            exchangeRate,
        });
        calculatedItems.push(pricing);
    }

    const subtotalUsd = calculatedItems.reduce(
        (sum, item) => sum.plus(toDecimal(item.lineTotalUsd)),
        new Decimal(0)
    );
    const subtotal = toFiat(subtotalUsd.times(exchangeRate));

    return {
        items: calculatedItems,
        subtotalUsd: decimalToCanonicalString(subtotalUsd),
        subtotal: String(subtotal),
        totalUsd: decimalToCanonicalString(subtotalUsd),
        total: String(subtotal),
        currency: orderCurrency,
        exchangeRate,
        pricingContext,
        calculationVersion: RESELLER_PRICING_CALCULATION_VERSION,
    };
};

const createOrderPricingSnapshot = ({ pricingContext, orderCurrency, exchangeRate, productPricing, profitUsd }) => ({
    pricingVersion: RESELLER_PRICING_CALCULATION_VERSION,
    customerCommercialSnapshot: {
        userId: normalizeObjectIdString(pricingContext.userId),
        resellerStatus: pricingContext.resellerStatus,
        effectiveGroupId: normalizeObjectIdString(pricingContext.effectiveGroup.id),
        effectiveGroupName: pricingContext.effectiveGroup.name,
        groupPercentage: pricingContext.effectiveGroup.percentage,
        pricingType: pricingContext.pricingType,
        eligibilityReason: pricingContext.pricingEligibility.reason,
    },
    currencySnapshot: {
        orderCurrency,
        exchangeRate,
        rateSource: orderCurrency === 'USD' ? 'USD_IDENTITY' : 'Currency.platformRate',
        capturedAt: new Date(),
    },
    subtotal: productPricing.lineTotal,
    total: productPricing.lineTotal,
    subtotalUsd: productPricing.lineTotalUsd,
    totalUsd: productPricing.lineTotalUsd,
    profitUsd: decimalToCanonicalString(profitUsd || '0'),
    items: [{
        productId: normalizeObjectIdString(productPricing.productId),
        productName: productPricing.productName,
        baseUnitPrice: productPricing.baseUnitPrice,
        groupPercentage: productPricing.groupPercentage,
        adjustmentAmount: productPricing.adjustmentAmount,
        finalUnitPrice: productPricing.finalUnitPrice,
        quantity: productPricing.quantity,
        lineTotal: productPricing.lineTotal,
        lineTotalUsd: productPricing.lineTotalUsd,
        currency: productPricing.currency,
        calculationVersion: productPricing.calculationVersion,
    }],
});

const serializeCustomerProductPrice = (product, pricingResult, pricingContext) => {
    const obj = typeof product?.toObject === 'function' ? product.toObject() : { ...(product || {}) };
    obj.finalPrice = pricingResult.finalUnitPrice;
    obj.displayCurrency = pricingResult.currency;
    obj.pricing = {
        finalUnitPrice: pricingResult.finalUnitPrice,
        displayCurrency: pricingResult.currency,
        pricingType: pricingContext.pricingType,
        effectiveGroupName: pricingContext.effectiveGroup.name,
        calculationVersion: RESELLER_PRICING_CALCULATION_VERSION,
    };
    return obj;
};

const previewPriceForAdmin = async ({ userId, productId, quantity = 1, currency = null, session = null }) => {
    const quote = await calculateOrderPricing({
        userId,
        items: [{ productId, quantity }],
        currency,
        session,
        rejectClientPricing: false,
    });
    const item = quote.items[0];
    return {
        userId: normalizeObjectIdString(userId),
        productId: normalizeObjectIdString(productId),
        quantity: item.quantity,
        currency: quote.currency,
        exchangeRate: quote.exchangeRate,
        pricingContext: quote.pricingContext,
        baseUnitPrice: item.baseUnitPrice,
        percentage: item.groupPercentage,
        adjustmentAmount: item.adjustmentAmount,
        finalUnitPrice: item.finalUnitPrice,
        lineTotal: item.lineTotal,
        lineTotalUsd: item.lineTotalUsd,
        calculationVersion: quote.calculationVersion,
    };
};

module.exports = {
    RESELLER_PRICING_CALCULATION_VERSION,
    PRICING_TYPES,
    PRICE_TAMPERING_FIELDS,
    calculateFinalUnitPrice,
    resolveEffectivePricingContext,
    calculateProductPrice,
    calculateOrderPricing,
    createOrderPricingSnapshot,
    serializeCustomerProductPrice,
    previewPriceForAdmin,
    assertNoPriceTampering,
};
