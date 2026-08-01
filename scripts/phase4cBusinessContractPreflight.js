'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Group = require('../src/modules/groups/group.model');
const { User, RESELLER_STATUS, REFERRAL_SOURCE } = require('../src/modules/users/user.model');
const { ReferralCommission } = require('../src/modules/referrals/referralCommission.model');
const { ReferralPayoutRequest } = require('../src/modules/referrals/referralPayoutRequest.model');
const { Product } = require('../src/modules/products/product.model');
const { ProviderProduct } = require('../src/modules/providers/providerProduct.model');
const { Order } = require('../src/modules/orders/order.model');

const PHASE_4C_CODES = Object.freeze({
    USERS_ASSIGNED_TO_DEFAULT_INSTEAD_OF_HIGHEST: 'USERS_ASSIGNED_TO_DEFAULT_INSTEAD_OF_HIGHEST',
    USERS_MISSING_COUNTRY: 'USERS_MISSING_COUNTRY',
    USERS_MISSING_CURRENCY: 'USERS_MISSING_CURRENCY',
    GOOGLE_USERS_WITH_INCOMPLETE_PROFILE: 'GOOGLE_USERS_WITH_INCOMPLETE_PROFILE',
    GOOGLE_USERS_WITH_INCONSISTENT_REFERRAL_METADATA: 'GOOGLE_USERS_WITH_INCONSISTENT_REFERRAL_METADATA',
    COMMISSIONS_AFTER_REFERRAL_WINDOW: 'COMMISSIONS_AFTER_REFERRAL_WINDOW',
    USD_ONLY_LEGACY_COMMISSIONS: 'USD_ONLY_LEGACY_COMMISSIONS',
    MIXED_OR_INCONSISTENT_PAYOUTS: 'MIXED_OR_INCONSISTENT_PAYOUTS',
    COMMISSION_CURRENCY_SNAPSHOT_MISMATCH: 'COMMISSION_CURRENCY_SNAPSHOT_MISMATCH',
    INVALID_OR_MISSING_CURRENCY_RATES: 'INVALID_OR_MISSING_CURRENCY_RATES',
    PROVIDER_ORDER_STATUS_REVIEW_REQUIRED: 'PROVIDER_ORDER_STATUS_REVIEW_REQUIRED',
    HIGH_PRECISION_PRICE_STORED_AS_NUMBER: 'HIGH_PRECISION_PRICE_STORED_AS_NUMBER',
    SUSPENDED_RESELLER_DEFAULT_GROUP_ASSIGNMENT: 'SUSPENDED_RESELLER_DEFAULT_GROUP_ASSIGNMENT',
});

const REFERRAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const assertCheckMode = (check = process.argv.includes('--check')) => {
    if (!check) {
        throw new Error('phase4cBusinessContractPreflight is read-only and requires --check.');
    }
};

const count = async (code, promise) => {
    try {
        return { code, count: await promise };
    } catch (error) {
        return { code, count: null, error: error.message };
    }
};

const runPhase4cBusinessContractPreflight = async ({ check, connection = null } = {}) => {
    assertCheckMode(check);
    if (!connection && mongoose.connection.readyState === 0) {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) throw new Error('MONGO_URI is required for read-only preflight checks.');
        await mongoose.connect(mongoUri);
    }

    const [highestGroup, defaultGroup] = await Promise.all([
        Group.findOne({ isActive: true, deletedAt: null }).sort({ percentage: -1, name: 1 }).lean(),
        Group.findOne({ isDefault: true, deletedAt: null }).lean(),
    ]);

    const results = [];
    results.push(await count(
        PHASE_4C_CODES.USERS_ASSIGNED_TO_DEFAULT_INSTEAD_OF_HIGHEST,
        highestGroup && defaultGroup && String(highestGroup._id) !== String(defaultGroup._id)
            ? User.countDocuments({
                role: 'CUSTOMER',
                resellerStatus: { $in: [null, RESELLER_STATUS.NONE, RESELLER_STATUS.REJECTED, RESELLER_STATUS.PENDING] },
                groupId: defaultGroup._id,
                deletedAt: null,
            })
            : Promise.resolve(0)
    ));
    results.push(await count(PHASE_4C_CODES.USERS_MISSING_COUNTRY, User.countDocuments({
        deletedAt: null,
        $or: [{ country: { $exists: false } }, { country: null }, { country: '' }],
    })));
    results.push(await count(PHASE_4C_CODES.USERS_MISSING_CURRENCY, User.countDocuments({
        deletedAt: null,
        $or: [{ currency: { $exists: false } }, { currency: null }, { currency: '' }],
    })));
    results.push(await count(PHASE_4C_CODES.GOOGLE_USERS_WITH_INCOMPLETE_PROFILE, User.countDocuments({
        googleId: { $exists: true, $ne: null },
        deletedAt: null,
        $or: [
            { country: { $exists: false } },
            { country: null },
            { country: '' },
            { currency: { $exists: false } },
            { currency: null },
            { currency: '' },
        ],
    })));
    results.push(await count(PHASE_4C_CODES.GOOGLE_USERS_WITH_INCONSISTENT_REFERRAL_METADATA, User.countDocuments({
        googleId: { $exists: true, $ne: null },
        deletedAt: null,
        $or: [
            { referredBy: { $ne: null }, referralSource: { $ne: REFERRAL_SOURCE.GOOGLE_OAUTH } },
            { referredBy: null, referredAt: { $ne: null } },
        ],
    })));
    results.push(await count(PHASE_4C_CODES.COMMISSIONS_AFTER_REFERRAL_WINDOW, ReferralCommission.countDocuments({
        $expr: {
            $gte: [
                '$availableAt',
                { $dateAdd: { startDate: '$referredAt', unit: 'millisecond', amount: REFERRAL_WINDOW_MS } },
            ],
        },
    })));
    results.push(await count(PHASE_4C_CODES.USD_ONLY_LEGACY_COMMISSIONS, ReferralCommission.countDocuments({
        $or: [
            { calculationVersion: 'v1' },
            { commissionAmount: { $exists: false } },
            { commissionAmount: null },
        ],
    })));
    results.push(await count(PHASE_4C_CODES.MIXED_OR_INCONSISTENT_PAYOUTS, ReferralPayoutRequest.countDocuments({
        $or: [
            { amount: { $exists: false } },
            { amount: null },
            { currency: { $exists: false } },
            { currency: null },
        ],
    })));
    results.push(await count(PHASE_4C_CODES.COMMISSION_CURRENCY_SNAPSHOT_MISMATCH, ReferralCommission.countDocuments({
        $expr: { $ne: ['$commissionCurrency', '$referrerCurrency'] },
    })));
    results.push(await count(PHASE_4C_CODES.INVALID_OR_MISSING_CURRENCY_RATES, ReferralCommission.countDocuments({
        $or: [
            { referrerExchangeRateFromUsd: { $exists: false } },
            { referrerExchangeRateFromUsd: null },
            { referrerExchangeRateFromUsd: '' },
        ],
        calculationVersion: { $ne: 'v1' },
    })));
    results.push(await count(PHASE_4C_CODES.PROVIDER_ORDER_STATUS_REVIEW_REQUIRED, Order.countDocuments({
        providerOrderId: { $exists: true, $ne: null },
        status: { $in: ['FAILED', 'CANCELED', 'MANUAL_REVIEW'] },
    })));
    results.push(await count(PHASE_4C_CODES.HIGH_PRECISION_PRICE_STORED_AS_NUMBER, Promise.all([
        Product.countDocuments({ basePrice: { $type: 'number' } }),
        ProviderProduct.countDocuments({ rawPrice: { $type: 'number' } }),
    ]).then(([products, providerProducts]) => products + providerProducts)));
    results.push(await count(PHASE_4C_CODES.SUSPENDED_RESELLER_DEFAULT_GROUP_ASSIGNMENT, defaultGroup
        ? User.countDocuments({
            resellerStatus: RESELLER_STATUS.SUSPENDED,
            groupId: defaultGroup._id,
            deletedAt: null,
        })
        : Promise.resolve(0)));

    return {
        mode: 'CHECK_ONLY',
        targetDatabase: mongoose.connection.name,
        results,
        note: 'Read-only aggregate classifications only. No documents, PII, credentials, provider calls, index creation, or repairs were performed.',
    };
};

if (require.main === module) {
    runPhase4cBusinessContractPreflight()
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect();
        });
}

module.exports = {
    PHASE_4C_CODES,
    runPhase4cBusinessContractPreflight,
};
