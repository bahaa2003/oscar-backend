'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const {
    WalletTransaction,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('../src/modules/wallet/walletTransaction.model');

const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;
const REQUIRED_INDEX_NAME = 'unique_wallet_source_operation';

const classifyWalletLedgerSourceGroup = ({ count = 0, hasCompleteSourceIdentity = false } = {}) => {
    if (!hasCompleteSourceIdentity) return 'LEGACY_OR_INCOMPLETE_SOURCE_IDENTITY';
    if (count > 1) return 'DUPLICATE_SOURCE_OPERATION';
    if (count === 1) return 'UNIQUE_SOURCE_OPERATION';
    return 'UNKNOWN';
};

const requireCheckFlag = () => {
    if (!process.argv.includes('--check')) {
        throw new Error('Refusing to connect without explicit --check flag.');
    }
};

const countDuplicateSourceGroups = async () => {
    const rows = await WalletTransaction.aggregate([
        {
            $match: {
                sourceType: { $type: 'string' },
                sourceId: { $type: 'objectId' },
                operation: { $type: 'string' },
            },
        },
        {
            $group: {
                _id: {
                    userId: '$userId',
                    sourceType: '$sourceType',
                    sourceId: '$sourceId',
                    operation: '$operation',
                },
                count: { $sum: 1 },
            },
        },
        { $match: { count: { $gt: 1 } } },
        {
            $group: {
                _id: null,
                duplicateGroups: { $sum: 1 },
                duplicateRows: { $sum: '$count' },
            },
        },
    ]);

    return rows[0] || { duplicateGroups: 0, duplicateRows: 0 };
};

const run = async () => {
    requireCheckFlag();

    if (!mongoUri) {
        throw new Error('MONGO_URI is required for wallet ledger idempotency preflight.');
    }

    await mongoose.connect(mongoUri);

    const [
        totalWalletTransactions,
        completeSourceIdentityRows,
        incompleteSourceIdentityRows,
        legacyDepositReferenceCreditRows,
        duplicateSourceGroups,
        indexExists,
    ] = await Promise.all([
        WalletTransaction.countDocuments(),
        WalletTransaction.countDocuments({
            sourceType: { $type: 'string' },
            sourceId: { $type: 'objectId' },
            operation: { $type: 'string' },
        }),
        WalletTransaction.countDocuments({
            $or: [
                { sourceType: { $type: 'string' }, sourceId: null },
                { sourceType: { $type: 'string' }, operation: null },
                { sourceId: { $type: 'objectId' }, sourceType: null },
                { sourceId: { $type: 'objectId' }, operation: null },
                { operation: { $type: 'string' }, sourceType: null },
                { operation: { $type: 'string' }, sourceId: null },
            ],
        }),
        WalletTransaction.countDocuments({
            type: TRANSACTION_OPERATIONS.CREDIT,
            reference: { $ne: null },
            $or: [{ sourceType: null }, { sourceType: { $exists: false } }],
        }),
        countDuplicateSourceGroups(),
        WalletTransaction.collection.indexExists(REQUIRED_INDEX_NAME),
    ]);

    const report = {
        totalWalletTransactions,
        completeSourceIdentityRows,
        incompleteSourceIdentityRows,
        legacyDepositReferenceCreditRows,
        duplicateSourceGroups: duplicateSourceGroups.duplicateGroups || 0,
        duplicateSourceRows: duplicateSourceGroups.duplicateRows || 0,
        expectedDepositSourceIdentity: {
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            operation: TRANSACTION_OPERATIONS.CREDIT,
        },
        requiredUniqueIndex: REQUIRED_INDEX_NAME,
        requiredUniqueIndexExists: Boolean(indexExists),
        writesPerformed: 0,
    };

    console.log(JSON.stringify(report, null, 2));

    if (!report.requiredUniqueIndexExists || report.incompleteSourceIdentityRows > 0 || report.duplicateSourceGroups > 0) {
        throw new Error('Wallet ledger idempotency preflight found blocking issues.');
    }
};

if (require.main === module) {
    run()
        .catch((err) => {
            console.error(`[walletLedgerIdempotencyPreflight] ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    classifyWalletLedgerSourceGroup,
    run,
};
