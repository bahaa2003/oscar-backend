'use strict';

/**
 * me.controller.js — User Panel: profile, wallet, orders, products, deposits
 *
 * All handlers operate on the authenticated user (req.user).
 * Ownership isolation: users can ONLY see their own data.
 */

const { User } = require('../users/user.model');
const { WalletTransaction } = require('../wallet/walletTransaction.model');
const orderService = require('../orders/order.service');
const depositService = require('../deposits/deposit.service');
const productService = require('../products/product.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { NotFoundError } = require('../../shared/errors/AppError');
const {
    resolveEffectivePricingContext,
    calculateProductPrice,
} = require('../pricing/commercialPricing.service');
const { getConversionRate } = require('../../services/currencyConverter.service');
const { usdToLocal } = require('../../shared/utils/currencyMath');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parsePage = (v) => Math.max(1, parseInt(v, 10) || 1);
const parseLimit = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20));

// =============================================================================
// PROFILE  —  GET /api/me
// =============================================================================

/**
 * Return the authenticated user's full profile including wallet and group info.
 */
const getProfile = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id)
        .select('-password -__v')
        .populate('groupId', 'name percentage isActive billingMode');

    if (!user) throw new NotFoundError('User');

    const groupData = user.groupId;
    const billingMode = groupData?.billingMode || 'standard';

    sendSuccess(res, {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        verified: user.verified,
        currency: user.currency,
        walletBalance: user.walletBalance,
        group: groupData,
        billingMode,
        quantityLimit: user.quantityLimit || 0,
        quantityUsed: user.quantityUsed || 0,
        quantityRemaining: user.quantityRemaining || 0,
        createdAt: user.createdAt,
    }, 'Profile retrieved.');
});

// =============================================================================
// WALLET  —  GET /api/me/wallet
// =============================================================================

/**
 * Wallet summary: balance + last 5 transactions.
 */
const getWallet = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id).select('walletBalance currency creditLimit');
    if (!user) throw new NotFoundError('User');

    const recent = await WalletTransaction.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('reference', 'orderNumber customerInput status totalPrice')
        .lean();

    sendSuccess(res, {
        walletBalance: user.walletBalance,
        currency: user.currency,
        recentTransactions: recent,
    }, 'Wallet summary retrieved.');
});

// =============================================================================
// WALLET TRANSACTIONS  —  GET /api/me/wallet/transactions
// =============================================================================

/**
 * Paginated transaction history for the authenticated user.
 * Query: page, limit, from (ISO date), to (ISO date)
 */
const getTransactions = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = { userId: req.user._id };

    if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
        if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
        WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice').lean(),
        WalletTransaction.countDocuments(filter),
    ]);

    sendPaginated(res, transactions, { page, limit, total, pages: Math.ceil(total / limit) }, 'Transactions retrieved.');
});

// =============================================================================
// ORDERS  —  GET /api/me/orders  |  GET /api/me/orders/:id
// =============================================================================

/**
 * Paginated order list for the authenticated user.
 * Query: status, page, limit, from, to
 */
const getOrders = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = {
        userId: req.user._id,
        ...(req.query.status && { status: req.query.status }),
    };

    if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
        if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const { Order } = require('../orders/order.model');
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name image')
            .lean(),
        Order.countDocuments(filter),
    ]);

    sendPaginated(res, orders, { page, limit, total, pages: Math.ceil(total / limit) }, 'Orders retrieved.');
});

/**
 * Single order by ID — enforces ownership.
 */
const getOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, order);
});

// =============================================================================
// PLACE ORDER  —  POST /api/me/orders
// =============================================================================

/**
 * Place a new order. Only ACTIVE + verified users can place orders.
 * Balance must be >= order cost (credit system removed).
 */
const placeOrder = catchAsync(async (req, res) => {
    const { productId, quantity, orderFieldsValues, link, target } = req.body;

    // Merge top-level link/target into orderFieldsValues so they always
    // reach customerInput (SMM providers need these as provider params).
    const mergedFields = { ...orderFieldsValues };
    if (link && !mergedFields.link) mergedFields.link = link;
    if (target && !mergedFields.target) mergedFields.target = target;
    const finalFields = Object.keys(mergedFields).length > 0 ? mergedFields : null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: 'CUSTOMER',
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10) || 1,
        idempotencyKey: req.headers['idempotency-key'] || null,
        orderFieldsValues: finalFields,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, order, 'Order already exists (idempotent response).');
    }
    sendCreated(res, order, 'Order placed successfully.');
});

// =============================================================================
// PRODUCTS  —  GET /api/me/products  |  GET /api/me/products/:id
// =============================================================================

/**
 * Public product catalogue for authenticated customers.
 * Prices follow the full pipeline:
 *   1. Base Price (USD from provider)
 *   2. Group Markup: markedUpUSD = basePrice × (1 + group.percentage / 100)
 *   3. Currency Conversion: displayPrice = markedUpUSD × userCurrencyRate
 */
const getProducts = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { Product } = require('../products/product.model');

    const filter = { isActive: true, deletedAt: null };
    if (req.query.search) {
        filter.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } },
        ];
    }

    const skip = (page - 1) * limit;
    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit)
            .select('-providerProduct -orderFields')
            .lean(),
        Product.countDocuments(filter),
    ]);

    // ── 1. Resolve user's group markup ────────────────────────────────────────
    const pricingContext = await resolveEffectivePricingContext(req.user._id);

    // ── 2. Resolve user's currency rate ───────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Apply pipeline: Base → Markup → Currency ───────────────────────────
    const converted = products.map((p) => {
        const pricing = calculateProductPrice({
            product: p,
            pricingContext,
            quantity: 1,
            currency: 'USD',
            exchangeRate: 1,
        });
        return {
            ...p,
            finalPrice: pricing.finalUnitPrice,
            markedUpPriceUSD: pricing.finalUnitPrice,
            displayPrice: usdToLocal(pricing.finalUnitPrice, rate),
            displayCurrency: userCurrency,
            pricing: {
                finalUnitPrice: pricing.finalUnitPrice,
                displayCurrency: userCurrency,
                pricingType: pricingContext.pricingType,
                effectiveGroupName: pricingContext.effectiveGroup.name,
                calculationVersion: pricing.calculationVersion,
            },
        };
    });

    sendPaginated(res, converted, { page, limit, total, pages: Math.ceil(total / limit) }, 'Products retrieved.');
});

/**
 * Single product detail — full pricing pipeline applied.
 */
const getProduct = catchAsync(async (req, res) => {
    const { Product } = require('../products/product.model');

    const product = await Product.findOne({ _id: req.params.id, isActive: true, deletedAt: null })
        .select('-providerProduct')
        .lean();

    if (!product) throw new NotFoundError('Product');

    // ── 1. Group markup ───────────────────────────────────────────────────────
    const pricingContext = await resolveEffectivePricingContext(req.user._id);

    // ── 2. Currency rate ──────────────────────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Pipeline: Base → Markup → Currency ─────────────────────────────────
    const pricing = calculateProductPrice({
        product,
        pricingContext,
        quantity: 1,
        currency: 'USD',
        exchangeRate: 1,
    });

    sendSuccess(res, {
        ...product,
        finalPrice: pricing.finalUnitPrice,
        markedUpPriceUSD: pricing.finalUnitPrice,
        displayPrice: usdToLocal(pricing.finalUnitPrice, rate),
        displayCurrency: userCurrency,
        pricing: {
            finalUnitPrice: pricing.finalUnitPrice,
            displayCurrency: userCurrency,
            pricingType: pricingContext.pricingType,
            effectiveGroupName: pricingContext.effectiveGroup.name,
            calculationVersion: pricing.calculationVersion,
        },
    });
});

// =============================================================================
// DEPOSITS  —  POST /api/me/deposits  |  GET /api/me/deposits  |  GET /api/me/deposits/:id
// =============================================================================

/**
 * Create a new deposit request.
 * Accepts multipart/form-data with a `receipt` file (via upload middleware).
 * The uploaded file path is stored as `receiptImage`.
 */
const createDeposit = catchAsync(async (req, res) => {
    // ── Validate file upload ─────────────────────────────────────────────
    if (!req.file) {
        const { BusinessRuleError } = require('../../shared/errors/AppError');
        throw new BusinessRuleError(
            'Receipt image is required. Please upload a file.',
            'RECEIPT_REQUIRED'
        );
    }

    const { requestedAmount, currency, paymentMethodId, notes } = req.body;
    const senderDetails = depositService.normalizeSenderDetails(req.body);

    // ── Fetch current exchange rate ──────────────────────────────────────
    const { Currency } = require('../currency/currency.model');
    const currencyDoc = await Currency.findOne({
        code: currency.toUpperCase(),
        isActive: true,
    });

    if (!currencyDoc) {
        const { BusinessRuleError } = require('../../shared/errors/AppError');
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported or is inactive.`,
            'INVALID_CURRENCY'
        );
    }

    const exchangeRate = currencyDoc.platformRate;

    // ── Calculate USD equivalent ─────────────────────────────────────────
    const parsedAmount = parseFloat(requestedAmount);
    const amountUsd = Number((parsedAmount / exchangeRate).toFixed(2));

    // ── Build relative receipt path ──────────────────────────────────────
    const receiptImage = `uploads/deposits/${req.file.filename}`;

    // ── Persist ──────────────────────────────────────────────────────────
    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        paymentMethodId,
        requestedAmount: parsedAmount,
        currency: currency.toUpperCase(),
        exchangeRate,
        amountUsd,
        receiptImage,
        notes: notes || null,
        senderDetails,
        auditContext: {
            actorId: req.user._id,
            actorRole: 'CUSTOMER',
            ipAddress: req.ip ?? null,
            userAgent: req.get('User-Agent') ?? null,
        },
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * List authenticated user's own deposit requests.
 * Query: status, page, limit
 */
const getDeposits = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status } = req.query;

    const result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * Single deposit by ID — user may only see their own.
 */
const getDeposit = catchAsync(async (req, res) => {
    const deposit = await depositService.getDepositById(req.params.id, req.user._id);
    sendSuccess(res, deposit);
});

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    getProfile,
    getWallet,
    getTransactions,
    getOrders,
    getOrder,
    placeOrder,
    getProducts,
    getProduct,
    createDeposit,
    getDeposits,
    getDeposit,
};
