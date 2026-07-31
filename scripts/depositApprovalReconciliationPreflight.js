'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const { DepositRequest } = require('../src/modules/deposits/deposit.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../src/modules/wallet/walletTransaction.model');
const {
    DEPOSIT_RECONCILIATION_CODES,
    classifyDepositApprovalState,
} = require('../src/modules/deposits/deposit.service');

const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;

const requireCheckFlag = () => {
    if (!process.argv.includes('--check')) {
        throw new Error('Refusing to connect without explicit --check flag.');
    }
};

const getDepositLedgers = (deposit) => WalletTransaction.find({
    userId: deposit.userId,
    type: TRANSACTION_TYPES.CREDIT,
    $or: [
        {
            sourceType: 'DEPOSIT',
            sourceId: deposit._id,
            operation: 'CREDIT',
        },
        {
            reference: deposit._id,
            $or: [
                { sourceType: null },
                { sourceType: { $exists: false } },
            ],
        },
    ],
}).select('_id type amount sourceType sourceId operation reference').lean();

const run = async () => {
    requireCheckFlag();

    if (!mongoUri) {
        throw new Error('MONGO_URI is required for deposit approval reconciliation preflight.');
    }

    await mongoose.connect(mongoUri);

    const counts = Object.fromEntries(
        Object.values(DEPOSIT_RECONCILIATION_CODES).map((classification) => [classification, 0])
    );
    let totalDepositsChecked = 0;

    const cursor = DepositRequest.find({})
        .select('_id userId status requestedAmount amountUsd')
        .lean()
        .cursor();

    for await (const deposit of cursor) {
        const ledgers = await getDepositLedgers(deposit);
        const classification = classifyDepositApprovalState({ deposit, ledgers });
        counts[classification] = (counts[classification] || 0) + 1;
        totalDepositsChecked += 1;
    }

    const blockingClassifications = [
        DEPOSIT_RECONCILIATION_CODES.APPROVED_WITHOUT_LEDGER,
        DEPOSIT_RECONCILIATION_CODES.APPROVED_WITH_MULTIPLE_LEDGERS,
        DEPOSIT_RECONCILIATION_CODES.APPROVED_WITH_LEDGER_AMOUNT_MISMATCH,
        DEPOSIT_RECONCILIATION_CODES.PENDING_WITH_EXISTING_LEDGER,
        DEPOSIT_RECONCILIATION_CODES.REJECTED_WITH_CREDIT_LEDGER,
    ];

    const blockingCount = blockingClassifications.reduce(
        (sum, classification) => sum + (counts[classification] || 0),
        0
    );

    const report = {
        totalDepositsChecked,
        classifications: counts,
        blockingCount,
        writesPerformed: 0,
    };

    console.log(JSON.stringify(report, null, 2));

    if (blockingCount > 0) {
        throw new Error('Deposit approval reconciliation preflight found blocking issues.');
    }
};

if (require.main === module) {
    run()
        .catch((err) => {
            console.error(`[depositApprovalReconciliationPreflight] ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    classifyDepositApprovalState,
    run,
};
