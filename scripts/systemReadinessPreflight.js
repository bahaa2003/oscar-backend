'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config/config');
const { classifyTopology } = require('./financialTopologyPreflight');
const { User } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');
const { Order } = require('../src/modules/orders/order.model');
const { WalletTransaction } = require('../src/modules/wallet/walletTransaction.model');
const { DepositRequest } = require('../src/modules/deposits/deposit.model');
const { ReferralCommission } = require('../src/modules/referrals/referralCommission.model');
const { ReferralPayoutRequest } = require('../src/modules/referrals/referralPayoutRequest.model');
const { ResellerApplication } = require('../src/modules/resellerApplications/resellerApplication.model');

const SYSTEM_READINESS_CODES = Object.freeze({
    PASS: 'PASS',
    WARN: 'WARN',
    FAIL: 'FAIL',
    NOT_RUN: 'NOT_RUN',
});

const REQUIRED_INDEXES = Object.freeze([
    {
        collection: 'users',
        model: User,
        name: 'unique_referral_code',
        description: 'Referral identity uniqueness/readiness',
    },
    {
        collection: 'users',
        model: User,
        name: 'referredBy_1_referredAt_-1',
        description: 'Referral dashboard invitee history',
    },
    {
        collection: 'wallettransactions',
        model: WalletTransaction,
        name: 'unique_wallet_source_operation',
        description: 'Wallet ledger source idempotency',
    },
    {
        collection: 'referralcommissions',
        model: ReferralCommission,
        name: 'unique_referral_commission_per_deposit',
        description: 'Referral commission idempotency',
    },
    {
        collection: 'referralpayoutrequests',
        model: ReferralPayoutRequest,
        name: 'unique_referral_payout_idempotency_key',
        description: 'Referral payout idempotency',
    },
    {
        collection: 'resellerapplications',
        model: ResellerApplication,
        name: 'unique_pending_reseller_application_per_user',
        description: 'Reseller application duplicate prevention',
    },
    {
        collection: 'orders',
        model: Order,
        name: 'unique_order_number_non_empty',
        description: 'Order number uniqueness for assigned numbers only',
    },
]);

const CONFIG_CHECKS = Object.freeze([
    { key: 'db.uri', required: true, secret: true },
    { key: 'jwt.secret', required: true, secret: true },
    { key: 'frontend.url', required: true, secret: false },
    { key: 'referralCommission.enabled', required: false, secret: false },
    { key: 'referralCommission.ratePercent', required: false, secret: false },
    { key: 'referralPayout.minUsd', required: false, secret: false },
    { key: 'reseller.reapplicationCooldownDays', required: false, secret: false },
]);

const getConfigValue = (path) => path
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), config);

const summarizeConfig = () => CONFIG_CHECKS.map((entry) => {
    const value = getConfigValue(entry.key);
    const present = value !== undefined && value !== null && String(value) !== '';
    return {
        key: entry.key,
        required: entry.required,
        secret: entry.secret,
        status: entry.required && !present ? SYSTEM_READINESS_CODES.FAIL : SYSTEM_READINESS_CODES.PASS,
        present,
    };
});

const summarizeIndexes = async () => Promise.all(REQUIRED_INDEXES.map(async (entry) => {
    const exists = await entry.model.collection.indexExists(entry.name);
    return {
        collection: entry.collection,
        index: entry.name,
        description: entry.description,
        status: exists ? SYSTEM_READINESS_CODES.PASS : SYSTEM_READINESS_CODES.WARN,
        productionActionNeeded: exists ? 'NONE' : 'VERIFY_OR_CREATE_DURING_CONTROLLED_ROLLOUT',
    };
}));

const summarizeDataReadiness = async () => {
    const [
        defaultGroups,
        duplicateWalletSources,
        duplicateOrderNumbers,
        nullOrderNumbers,
        depositsMissingEvaluation,
        commissionsWithoutDeposit,
        payoutCount,
        applicationCount,
        ordersMissingPricingSnapshot,
    ] = await Promise.all([
        Group.countDocuments({ isDefault: true, deletedAt: null }),
        WalletTransaction.aggregate([
            {
                $match: {
                    sourceType: { $ne: null },
                    sourceId: { $ne: null },
                    operation: { $ne: null },
                },
            },
            {
                $group: {
                    _id: {
                        sourceType: '$sourceType',
                        sourceId: '$sourceId',
                        operation: '$operation',
                    },
                    count: { $sum: 1 },
                },
            },
            { $match: { count: { $gt: 1 } } },
            { $limit: 1 },
        ]),
        Order.aggregate([
            { $match: { orderNumber: { $type: 'string', $gt: '' } } },
            { $group: { _id: '$orderNumber', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $limit: 1 },
        ]),
        Order.countDocuments({ $or: [{ orderNumber: null }, { orderNumber: '' }, { orderNumber: { $exists: false } }] }),
        DepositRequest.countDocuments({
            status: 'APPROVED',
            referralCommissionEvaluation: { $exists: false },
        }),
        ReferralCommission.aggregate([
            {
                $lookup: {
                    from: 'depositrequests',
                    localField: 'depositId',
                    foreignField: '_id',
                    as: 'deposit',
                },
            },
            { $match: { deposit: { $size: 0 } } },
            { $limit: 1 },
        ]),
        ReferralPayoutRequest.countDocuments(),
        ResellerApplication.countDocuments(),
        Order.countDocuments({
            $or: [
                { pricingSnapshot: null },
                { pricingSnapshot: { $exists: false } },
            ],
        }),
    ]);

    return [
        {
            name: 'defaultGroup',
            status: defaultGroups === 1 ? SYSTEM_READINESS_CODES.PASS : SYSTEM_READINESS_CODES.WARN,
            count: defaultGroups,
        },
        {
            name: 'walletLedgerDuplicateSourceIdentity',
            status: duplicateWalletSources.length ? SYSTEM_READINESS_CODES.FAIL : SYSTEM_READINESS_CODES.PASS,
            count: duplicateWalletSources.length,
        },
        {
            name: 'duplicateOrderNumbers',
            status: duplicateOrderNumbers.length ? SYSTEM_READINESS_CODES.FAIL : SYSTEM_READINESS_CODES.PASS,
            count: duplicateOrderNumbers.length,
        },
        {
            name: 'legacyNullOrderNumbers',
            status: nullOrderNumbers ? SYSTEM_READINESS_CODES.WARN : SYSTEM_READINESS_CODES.PASS,
            count: nullOrderNumbers,
        },
        {
            name: 'legacyApprovedDepositsMissingCommissionEvaluation',
            status: depositsMissingEvaluation ? SYSTEM_READINESS_CODES.WARN : SYSTEM_READINESS_CODES.PASS,
            count: depositsMissingEvaluation,
        },
        {
            name: 'commissionsWithoutDeposit',
            status: commissionsWithoutDeposit.length ? SYSTEM_READINESS_CODES.FAIL : SYSTEM_READINESS_CODES.PASS,
            count: commissionsWithoutDeposit.length,
        },
        {
            name: 'referralPayoutRecords',
            status: SYSTEM_READINESS_CODES.PASS,
            count: payoutCount,
        },
        {
            name: 'resellerApplicationRecords',
            status: SYSTEM_READINESS_CODES.PASS,
            count: applicationCount,
        },
        {
            name: 'ordersMissingPricingSnapshot',
            status: ordersMissingPricingSnapshot ? SYSTEM_READINESS_CODES.WARN : SYSTEM_READINESS_CODES.PASS,
            count: ordersMissingPricingSnapshot,
        },
    ];
};

const computeOverallStatus = (sections) => {
    const flat = Object.values(sections).flat();
    if (flat.some((item) => item.status === SYSTEM_READINESS_CODES.FAIL)) return SYSTEM_READINESS_CODES.FAIL;
    if (flat.some((item) => item.status === SYSTEM_READINESS_CODES.WARN)) return SYSTEM_READINESS_CODES.WARN;
    return SYSTEM_READINESS_CODES.PASS;
};

const runSystemReadinessPreflight = async () => {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const topologyType = mongoose.connection.client.topology?.description?.type || 'Unknown';
    const topology = [{
        name: 'mongodbTransactionTopology',
        ...classifyTopology({ hello, topologyType }),
    }];
    topology[0].status = topology[0].likelySupportsTransactions
        ? SYSTEM_READINESS_CODES.PASS
        : SYSTEM_READINESS_CODES.FAIL;

    const sections = {
        topology,
        configuration: summarizeConfig(),
        indexes: await summarizeIndexes(),
        data: await summarizeDataReadiness(),
    };

    return {
        checkedAt: new Date().toISOString(),
        overallStatus: computeOverallStatus(sections),
        sections,
    };
};

const main = async () => {
    if (!process.argv.includes('--check')) {
        console.log('Usage: node scripts/systemReadinessPreflight.js --check');
        process.exitCode = 1;
        return;
    }

    const uri = config.db.uri;
    if (!uri) {
        console.log('NOT RUN - No MongoDB connection URI supplied.');
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    const result = await runSystemReadinessPreflight();
    console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
    main()
        .catch((err) => {
            console.error(JSON.stringify({
                success: false,
                code: err.code || 'SYSTEM_READINESS_PREFLIGHT_FAILED',
                message: err.message,
            }));
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    SYSTEM_READINESS_CODES,
    REQUIRED_INDEXES,
    summarizeConfig,
    computeOverallStatus,
    runSystemReadinessPreflight,
};
