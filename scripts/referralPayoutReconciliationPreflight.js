'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const { ReferralPayoutRequest, PAYOUT_STATUS, PAYOUT_METHOD } = require('../src/modules/referrals/referralPayoutRequest.model');
const { ReferralCommission, COMMISSION_STATUS } = require('../src/modules/referrals/referralCommission.model');
const { WalletTransaction, TRANSACTION_TYPES, TRANSACTION_SOURCE_TYPES, TRANSACTION_OPERATIONS } = require('../src/modules/wallet/walletTransaction.model');
const { Decimal } = require('../src/shared/utils/decimalPrecision');

const PAYOUT_RECONCILIATION_CODES = Object.freeze({
    HEALTHY_PENDING: 'HEALTHY_PENDING',
    HEALTHY_PAID_WALLET: 'HEALTHY_PAID_WALLET',
    HEALTHY_PAID_MANUAL: 'HEALTHY_PAID_MANUAL',
    HEALTHY_REJECTED: 'HEALTHY_REJECTED',
    PENDING_WITH_AVAILABLE_COMMISSION: 'PENDING_WITH_AVAILABLE_COMMISSION',
    PENDING_WITH_MISSING_COMMISSION: 'PENDING_WITH_MISSING_COMMISSION',
    PENDING_WITH_FOREIGN_LOCK: 'PENDING_WITH_FOREIGN_LOCK',
    PAID_WITH_LOCKED_COMMISSION: 'PAID_WITH_LOCKED_COMMISSION',
    PAID_WITH_MISSING_WALLET_LEDGER: 'PAID_WITH_MISSING_WALLET_LEDGER',
    PAID_WITH_DUPLICATE_WALLET_LEDGER: 'PAID_WITH_DUPLICATE_WALLET_LEDGER',
    REJECTED_WITH_LOCKED_COMMISSION: 'REJECTED_WITH_LOCKED_COMMISSION',
    TOTAL_MISMATCH: 'TOTAL_MISMATCH',
    UNKNOWN: 'UNKNOWN',
});

const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;

const requireCheckFlag = () => {
    if (!process.argv.includes('--check')) {
        throw new Error('Refusing to connect without explicit --check flag.');
    }
};

const toMoneyString = (value) => new Decimal(value || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

const idsMatch = (left = [], right = []) => {
    const a = left.map(String).sort();
    const b = right.map(String).sort();
    return a.length === b.length && a.every((id, index) => id === b[index]);
};

const classifyReferralPayoutState = ({ payout, commissions = [], walletLedgers = [] }) => {
    if (!payout) return PAYOUT_RECONCILIATION_CODES.UNKNOWN;

    const commissionIds = payout.commissionIds || [];
    if (commissions.length !== commissionIds.length) {
        return PAYOUT_RECONCILIATION_CODES.PENDING_WITH_MISSING_COMMISSION;
    }
    if (!idsMatch(commissions.map((commission) => commission._id), commissionIds)) {
        return PAYOUT_RECONCILIATION_CODES.PENDING_WITH_MISSING_COMMISSION;
    }

    const total = commissions.reduce(
        (sum, commission) => sum.plus(new Decimal(commission.commissionAmountUsd || 0)),
        new Decimal(0)
    );
    if (toMoneyString(total) !== toMoneyString(payout.amountUsd)) {
        return PAYOUT_RECONCILIATION_CODES.TOTAL_MISMATCH;
    }

    if (payout.status === PAYOUT_STATUS.PENDING) {
        if (commissions.some((commission) => String(commission.referrerId) !== String(payout.referrerId))) {
            return PAYOUT_RECONCILIATION_CODES.PENDING_WITH_FOREIGN_LOCK;
        }
        const healthy = commissions.every((commission) => (
            commission.status === COMMISSION_STATUS.LOCKED
            && String(commission.payoutRequestId || '') === String(payout._id)
        ));
        return healthy
            ? PAYOUT_RECONCILIATION_CODES.HEALTHY_PENDING
            : PAYOUT_RECONCILIATION_CODES.PENDING_WITH_AVAILABLE_COMMISSION;
    }

    if (payout.status === PAYOUT_STATUS.REJECTED) {
        return commissions.every((commission) => commission.status === COMMISSION_STATUS.AVAILABLE && !commission.payoutRequestId)
            ? PAYOUT_RECONCILIATION_CODES.HEALTHY_REJECTED
            : PAYOUT_RECONCILIATION_CODES.REJECTED_WITH_LOCKED_COMMISSION;
    }

    if (payout.status === PAYOUT_STATUS.PAID) {
        if (!commissions.every((commission) => (
            commission.status === COMMISSION_STATUS.PAID
            && String(commission.payoutRequestId || '') === String(payout._id)
        ))) {
            return PAYOUT_RECONCILIATION_CODES.PAID_WITH_LOCKED_COMMISSION;
        }

        if (payout.method === PAYOUT_METHOD.MANUAL) {
            return walletLedgers.length === 0 && payout.externalReference
                ? PAYOUT_RECONCILIATION_CODES.HEALTHY_PAID_MANUAL
                : PAYOUT_RECONCILIATION_CODES.UNKNOWN;
        }

        if (walletLedgers.length === 0) return PAYOUT_RECONCILIATION_CODES.PAID_WITH_MISSING_WALLET_LEDGER;
        if (walletLedgers.length > 1) return PAYOUT_RECONCILIATION_CODES.PAID_WITH_DUPLICATE_WALLET_LEDGER;
        return toMoneyString(walletLedgers[0].amount) === toMoneyString(payout.amountUsd)
            ? PAYOUT_RECONCILIATION_CODES.HEALTHY_PAID_WALLET
            : PAYOUT_RECONCILIATION_CODES.TOTAL_MISMATCH;
    }

    return PAYOUT_RECONCILIATION_CODES.UNKNOWN;
};

const getWalletLedgers = (payout) => WalletTransaction.find({
    userId: payout.referrerId,
    type: TRANSACTION_TYPES.CREDIT,
    sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
    sourceId: payout._id,
    operation: TRANSACTION_OPERATIONS.CREDIT,
}).select('_id userId amount sourceType sourceId operation').lean();

const run = async () => {
    requireCheckFlag();
    if (!mongoUri) {
        throw new Error('MONGO_URI is required for referral payout reconciliation preflight.');
    }

    await mongoose.connect(mongoUri);

    const payoutIdArg = process.argv.find((arg) => arg.startsWith('--payout-id='));
    const filter = {};
    if (payoutIdArg) {
        const id = payoutIdArg.split('=').slice(1).join('=');
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new Error('--payout-id must be a valid ObjectId.');
        }
        filter._id = new mongoose.Types.ObjectId(id);
    }

    const counts = Object.fromEntries(
        Object.values(PAYOUT_RECONCILIATION_CODES).map((classification) => [classification, 0])
    );
    let totalPayoutsChecked = 0;

    const cursor = ReferralPayoutRequest.find(filter)
        .select('_id referrerId commissionIds amountUsd method status externalReference walletTransactionId')
        .lean()
        .cursor();

    for await (const payout of cursor) {
        const [commissions, walletLedgers] = await Promise.all([
            ReferralCommission.find({ _id: { $in: payout.commissionIds } })
                .select('_id referrerId status payoutRequestId commissionAmountUsd')
                .lean(),
            getWalletLedgers(payout),
        ]);
        const classification = classifyReferralPayoutState({ payout, commissions, walletLedgers });
        counts[classification] = (counts[classification] || 0) + 1;
        totalPayoutsChecked += 1;
    }

    const blockingCount = Object.entries(counts)
        .filter(([classification]) => !classification.startsWith('HEALTHY_'))
        .reduce((sum, [, count]) => sum + count, 0);

    console.log(JSON.stringify({
        totalPayoutsChecked,
        classifications: counts,
        blockingCount,
        writesPerformed: 0,
    }, null, 2));

    if (blockingCount > 0) {
        throw new Error('Referral payout reconciliation preflight found blocking issues.');
    }
};

if (require.main === module) {
    run()
        .catch((err) => {
            console.error(`[referralPayoutReconciliationPreflight] ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    PAYOUT_RECONCILIATION_CODES,
    classifyReferralPayoutState,
    run,
};
