'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const { User, RESELLER_STATUS, USER_STATUS } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');
const { Product } = require('../src/modules/products/product.model');
const { Order } = require('../src/modules/orders/order.model');
const { calculateFinalUnitPrice } = require('../src/modules/pricing/commercialPricing.service');
const { compare, multiply } = require('../src/shared/utils/decimalPrecision');

const RESELLER_PRICING_RECONCILIATION_CODES = Object.freeze({
    HEALTHY_APPROVED_RESELLER: 'HEALTHY_APPROVED_RESELLER',
    HEALTHY_NORMAL_CUSTOMER: 'HEALTHY_NORMAL_CUSTOMER',
    APPROVED_WITH_MISSING_GROUP: 'APPROVED_WITH_MISSING_GROUP',
    APPROVED_WITH_INACTIVE_GROUP: 'APPROVED_WITH_INACTIVE_GROUP',
    APPROVED_WITH_DELETED_GROUP: 'APPROVED_WITH_DELETED_GROUP',
    APPROVED_WITH_GROUP_MISMATCH: 'APPROVED_WITH_GROUP_MISMATCH',
    SUSPENDED_NOT_ON_DEFAULT_GROUP: 'SUSPENDED_NOT_ON_DEFAULT_GROUP',
    MALFORMED_GROUP_PERCENTAGE: 'MALFORMED_GROUP_PERCENTAGE',
    NEGATIVE_RESULTING_PRICE: 'NEGATIVE_RESULTING_PRICE',
    ORDER_MISSING_PRICING_SNAPSHOT: 'ORDER_MISSING_PRICING_SNAPSHOT',
    ORDER_TOTAL_MISMATCH: 'ORDER_TOTAL_MISMATCH',
    UNKNOWN: 'UNKNOWN',
});

const redactId = (value) => String(value || '').replace(/^(.{6}).+(.{4})$/, '$1...$2');

const findDefaultGroup = async () => Group.findOne({ isDefault: true, deletedAt: null }).lean();

const classifyUserPricingState = async (user, defaultGroup = null) => {
    if (!user) return RESELLER_PRICING_RECONCILIATION_CODES.UNKNOWN;
    if (user.resellerStatus === RESELLER_STATUS.APPROVED) {
        if (!user.resellerGroupId) return RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_MISSING_GROUP;
        if (!user.groupId || String(user.groupId) !== String(user.resellerGroupId)) {
            return RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_GROUP_MISMATCH;
        }
        const group = await Group.findById(user.resellerGroupId).lean();
        if (!group) return RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_MISSING_GROUP;
        if (group.deletedAt) return RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_DELETED_GROUP;
        if (group.isActive === false) return RESELLER_PRICING_RECONCILIATION_CODES.APPROVED_WITH_INACTIVE_GROUP;
        if (!Number.isFinite(Number(group.percentage)) || Number(group.percentage) < 0) {
            return RESELLER_PRICING_RECONCILIATION_CODES.MALFORMED_GROUP_PERCENTAGE;
        }
        return RESELLER_PRICING_RECONCILIATION_CODES.HEALTHY_APPROVED_RESELLER;
    }

    if (user.resellerStatus === RESELLER_STATUS.SUSPENDED && defaultGroup) {
        if (String(user.groupId || '') !== String(defaultGroup._id)) {
            return RESELLER_PRICING_RECONCILIATION_CODES.SUSPENDED_NOT_ON_DEFAULT_GROUP;
        }
    }

    return RESELLER_PRICING_RECONCILIATION_CODES.HEALTHY_NORMAL_CUSTOMER;
};

const classifyProductGroupPrice = (product, group) => {
    try {
        const result = calculateFinalUnitPrice(product?.basePrice || '0', group?.percentage ?? 0);
        if (compare(result.finalUnitPrice, '0') < 0) {
            return RESELLER_PRICING_RECONCILIATION_CODES.NEGATIVE_RESULTING_PRICE;
        }
        return null;
    } catch {
        return RESELLER_PRICING_RECONCILIATION_CODES.MALFORMED_GROUP_PERCENTAGE;
    }
};

const classifyOrderPricingSnapshot = (order) => {
    if (!order?.pricingSnapshot) {
        return RESELLER_PRICING_RECONCILIATION_CODES.ORDER_MISSING_PRICING_SNAPSHOT;
    }
    const expectedUsd = multiply(order.finalPriceCharged || order.unitPrice || '0', String(order.quantity || 1));
    if (order.usdAmount != null && compare(expectedUsd, order.usdAmount) !== 0) {
        return RESELLER_PRICING_RECONCILIATION_CODES.ORDER_TOTAL_MISMATCH;
    }
    return null;
};

const runPreflight = async ({ userId = null, orderId = null, productId = null } = {}) => {
    const defaultGroup = await findDefaultGroup();
    const counts = {};
    const add = (code) => {
        counts[code] = (counts[code] || 0) + 1;
    };

    const userFilter = { deletedAt: null };
    if (userId) userFilter._id = userId;
    const users = await User.find(userFilter)
        .select('status deletedAt groupId resellerStatus resellerGroupId')
        .lean();
    for (const user of users) {
        if (user.status !== USER_STATUS.ACTIVE && user.resellerStatus !== RESELLER_STATUS.APPROVED) continue;
        add(await classifyUserPricingState(user, defaultGroup));
    }

    const productFilter = { deletedAt: null };
    if (productId) productFilter._id = productId;
    const [sampleProduct, groups] = await Promise.all([
        Product.findOne(productFilter).lean(),
        Group.find({ deletedAt: null }).lean(),
    ]);
    if (sampleProduct) {
        for (const group of groups) {
            const code = classifyProductGroupPrice(sampleProduct, group);
            if (code) add(code);
        }
    }

    const orderFilter = {};
    if (orderId) orderFilter._id = orderId;
    const orders = await Order.find(orderFilter).limit(orderId ? 1 : 500).lean();
    for (const order of orders) {
        const code = classifyOrderPricingSnapshot(order);
        if (code) add(code);
    }

    return counts;
};

const main = async () => {
    const args = process.argv.slice(2);
    if (!args.includes('--check')) {
        console.log('Usage: node scripts/resellerPricingReconciliationPreflight.js --check [--userId ID] [--orderId ID] [--productId ID]');
        process.exitCode = 1;
        return;
    }

    const readArg = (name) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : null;
    };

    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_TEST_URI;
    if (!uri) {
        console.log('NOT RUN - No MongoDB connection URI supplied.');
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(uri);
    const result = await runPreflight({
        userId: readArg('--userId'),
        orderId: readArg('--orderId'),
        productId: readArg('--productId'),
    });
    console.log(JSON.stringify({
        checkedAt: new Date().toISOString(),
        connection: 'configured',
        focused: {
            userId: readArg('--userId') ? redactId(readArg('--userId')) : null,
            orderId: readArg('--orderId') ? redactId(readArg('--orderId')) : null,
            productId: readArg('--productId') ? redactId(readArg('--productId')) : null,
        },
        classifications: result,
    }, null, 2));
    await mongoose.disconnect();
};

if (require.main === module) {
    main().catch(async (err) => {
        console.error(JSON.stringify({ success: false, code: err.code || 'UNKNOWN', message: err.message }));
        await mongoose.disconnect().catch(() => {});
        process.exitCode = 1;
    });
}

module.exports = {
    RESELLER_PRICING_RECONCILIATION_CODES,
    classifyUserPricingState,
    classifyProductGroupPrice,
    classifyOrderPricingSnapshot,
    runPreflight,
};
