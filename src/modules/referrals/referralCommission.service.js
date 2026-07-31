'use strict';

const mongoose = require('mongoose');
const config = require('../../config/config');
const { User, USER_STATUS } = require('../users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
    COMMISSION_CURRENCY,
    COMMISSION_CALCULATION_VERSION,
    COMMISSION_POLICY_SOURCE,
} = require('./referralCommission.model');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const { Decimal } = require('../../shared/utils/decimalPrecision');

const COMMISSION_EVALUATION_OUTCOME = Object.freeze({
    CREATED: 'CREATED',
    NOT_ELIGIBLE: 'NOT_ELIGIBLE',
    DISABLED: 'DISABLED',
});

const COMMISSION_EVALUATION_REASON = Object.freeze({
    CREATED: 'CREATED',
    COMMISSION_DISABLED: 'COMMISSION_DISABLED',
    RATE_ZERO: 'RATE_ZERO',
    NO_REFERRER: 'NO_REFERRER',
    INVALID_REFERRAL_RELATION: 'INVALID_REFERRAL_RELATION',
    REFERRER_INACTIVE: 'REFERRER_INACTIVE',
    REFERRER_DELETED: 'REFERRER_DELETED',
    SELF_REFERRAL: 'SELF_REFERRAL',
    COMMISSION_STOPPED: 'COMMISSION_STOPPED',
    ZERO_SOURCE_AMOUNT: 'ZERO_SOURCE_AMOUNT',
    ZERO_AFTER_ROUNDING: 'ZERO_AFTER_ROUNDING',
});

const toDecimalStrict = (value, code = 'INVALID_REFERRAL_COMMISSION_CONFIG') => {
    try {
        const decimal = new Decimal(value);
        if (!decimal.isFinite()) throw new Error('non-finite');
        return decimal;
    } catch (_) {
        throw new BusinessRuleError('Referral commission configuration is invalid.', code);
    }
};

const toMoneyString = (value) => (
    new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
);

const toRateString = (value) => (
    new Decimal(value)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toFixed(6)
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '') || '0'
);

const objectIdsEqual = (left, right) => (
    left != null
    && right != null
    && String(left) === String(right)
);

const getReferralCommissionPolicy = () => {
    const policy = config.referralCommission || {};
    const enabled = policy.enabled === true;

    if (!enabled) {
        return {
            enabled: false,
            ratePercent: null,
            policySource: COMMISSION_POLICY_SOURCE,
        };
    }

    if (policy.ratePercent === null || policy.ratePercent === undefined || policy.ratePercent === '') {
        throw new BusinessRuleError(
            'Referral commission rate must be configured when commission engine is enabled.',
            'INVALID_REFERRAL_COMMISSION_CONFIG'
        );
    }

    const rate = toDecimalStrict(policy.ratePercent);
    if (rate.isNegative() || rate.greaterThan(100)) {
        throw new BusinessRuleError(
            'Referral commission rate must be between 0 and 100.',
            'INVALID_REFERRAL_COMMISSION_CONFIG'
        );
    }

    return {
        enabled: true,
        ratePercent: toRateString(rate),
        policySource: COMMISSION_POLICY_SOURCE,
    };
};

const makeEvaluation = ({
    outcome,
    reason,
    commissionId = null,
    referrerId = null,
    ratePercent = null,
    amountUsd = null,
    evaluatedAt,
}) => ({
    version: COMMISSION_CALCULATION_VERSION,
    outcome,
    reason,
    commissionId,
    referrerId,
    ratePercent,
    amountUsd,
    evaluatedAt,
});

const notEligible = ({ reason, referrerId = null, ratePercent = null, amountUsd = null, evaluatedAt }) => ({
    eligible: false,
    evaluation: makeEvaluation({
        outcome: COMMISSION_EVALUATION_OUTCOME.NOT_ELIGIBLE,
        reason,
        referrerId,
        ratePercent,
        amountUsd,
        evaluatedAt,
    }),
});

const evaluateDepositCommission = async ({
    referredUser,
    approvalTimestamp,
    sourceAmountUsd,
    session,
}) => {
    const evaluatedAt = approvalTimestamp || new Date();
    const policy = getReferralCommissionPolicy();

    if (!policy.enabled) {
        return {
            eligible: false,
            evaluation: makeEvaluation({
                outcome: COMMISSION_EVALUATION_OUTCOME.DISABLED,
                reason: COMMISSION_EVALUATION_REASON.COMMISSION_DISABLED,
                evaluatedAt,
            }),
        };
    }

    const rate = new Decimal(policy.ratePercent);
    if (rate.isZero()) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.RATE_ZERO,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    const sourceUsd = toDecimalStrict(sourceAmountUsd, 'INVALID_DEPOSIT_SNAPSHOT');
    if (!sourceUsd.greaterThan(0)) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.ZERO_SOURCE_AMOUNT,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (!referredUser?.referredBy) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.NO_REFERRER,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (
        !(referredUser.referredAt instanceof Date)
        || Number.isNaN(referredUser.referredAt.getTime())
        || referredUser.referredAt > evaluatedAt
    ) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.INVALID_REFERRAL_RELATION,
            referrerId: referredUser.referredBy,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (objectIdsEqual(referredUser._id, referredUser.referredBy)) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.SELF_REFERRAL,
            referrerId: referredUser.referredBy,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    const referrerQuery = User.findById(referredUser.referredBy)
        .select('status deletedAt +referrerCommissionStoppedAt');
    if (session) referrerQuery.session(session);
    const referrer = await referrerQuery;

    if (!referrer) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.INVALID_REFERRAL_RELATION,
            referrerId: referredUser.referredBy,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (referrer.status !== USER_STATUS.ACTIVE) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.REFERRER_INACTIVE,
            referrerId: referrer._id,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (referrer.deletedAt) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.REFERRER_DELETED,
            referrerId: referrer._id,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    if (
        referrer.referrerCommissionStoppedAt instanceof Date
        && referrer.referrerCommissionStoppedAt <= evaluatedAt
    ) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.COMMISSION_STOPPED,
            referrerId: referrer._id,
            ratePercent: policy.ratePercent,
            evaluatedAt,
        });
    }

    const commissionAmountUsd = sourceUsd
        .times(rate)
        .dividedBy(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    if (commissionAmountUsd.isZero()) {
        return notEligible({
            reason: COMMISSION_EVALUATION_REASON.ZERO_AFTER_ROUNDING,
            referrerId: referrer._id,
            ratePercent: policy.ratePercent,
            amountUsd: commissionAmountUsd.toFixed(2),
            evaluatedAt,
        });
    }

    return {
        eligible: true,
        referrer,
        ratePercent: policy.ratePercent,
        commissionAmountUsd: commissionAmountUsd.toFixed(2),
        evaluation: makeEvaluation({
            outcome: COMMISSION_EVALUATION_OUTCOME.CREATED,
            reason: COMMISSION_EVALUATION_REASON.CREATED,
            referrerId: referrer._id,
            ratePercent: policy.ratePercent,
            amountUsd: commissionAmountUsd.toFixed(2),
            evaluatedAt,
        }),
    };
};

const findCommissionByDeposit = async (depositId, { session } = {}) => {
    const query = ReferralCommission.findOne({ depositId });
    if (session) query.session(session);
    return query;
};

const createDepositCommission = async ({
    referrer,
    referredUser,
    deposit,
    walletTransaction,
    evaluation,
    session,
}) => {
    const existing = await findCommissionByDeposit(deposit._id, { session });
    if (existing) {
        throw new BusinessRuleError(
            'A referral commission already exists for this deposit.',
            'DEPOSIT_RECONCILIATION_REQUIRED'
        );
    }

    const doc = {
        referrerId: referrer._id,
        referredUserId: referredUser._id,
        depositId: deposit._id,
        walletTransactionId: walletTransaction._id,
        sourceAmount: toMoneyString(deposit.requestedAmount),
        sourceCurrency: deposit.currency,
        sourceExchangeRate: toRateString(deposit.exchangeRate),
        sourceAmountUsd: toMoneyString(deposit.amountUsd),
        commissionRatePercent: evaluation.ratePercent,
        commissionAmountUsd: evaluation.amountUsd,
        commissionCurrency: COMMISSION_CURRENCY,
        status: COMMISSION_STATUS.AVAILABLE,
        availableAt: deposit.reviewedAt,
        lockedAt: null,
        paidAt: null,
        cancelledAt: null,
        referralSource: referredUser.referralSource || null,
        referredAt: referredUser.referredAt,
        calculationVersion: COMMISSION_CALCULATION_VERSION,
        policySource: COMMISSION_POLICY_SOURCE,
        idempotencyKey: `deposit:${deposit._id}:referral-commission:v1`,
    };

    const [commission] = session
        ? await ReferralCommission.create([doc], { session })
        : await ReferralCommission.create([doc]);

    return commission;
};

const listCommissionsForReferrer = async (referrerId, {
    status,
    page = 1,
    limit = 20,
    dateFrom,
    dateTo,
} = {}) => {
    const filter = { referrerId };
    if (status) filter.status = String(status).toUpperCase();
    if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
        if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [commissions, total] = await Promise.all([
        ReferralCommission.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean(),
        ReferralCommission.countDocuments(filter),
    ]);

    return {
        commissions,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit),
        },
    };
};

const getCommissionSummaryForReferrer = async (referrerId) => {
    const objectId = typeof referrerId === 'string'
        ? new mongoose.Types.ObjectId(referrerId)
        : referrerId;

    const rows = await ReferralCommission.aggregate([
        { $match: { referrerId: objectId } },
        {
            $group: {
                _id: '$status',
                total: { $sum: { $toDecimal: '$commissionAmountUsd' } },
                count: { $sum: 1 },
            },
        },
    ]);

    const totals = Object.fromEntries(
        Object.values(COMMISSION_STATUS).map((status) => [status, '0.00'])
    );
    let count = 0;

    for (const row of rows) {
        totals[row._id] = toMoneyString(row.total.toString());
        count += row.count;
    }

    return { totals, count };
};

module.exports = {
    COMMISSION_EVALUATION_OUTCOME,
    COMMISSION_EVALUATION_REASON,
    getReferralCommissionPolicy,
    evaluateDepositCommission,
    createDepositCommission,
    findCommissionByDeposit,
    listCommissionsForReferrer,
    getCommissionSummaryForReferrer,
    toMoneyString,
    toRateString,
};
