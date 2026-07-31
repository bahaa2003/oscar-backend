'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { User, USER_STATUS } = require('../users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
    COMMISSION_CURRENCY,
} = require('./referralCommission.model');
const {
    ReferralPayoutRequest,
    PAYOUT_STATUS,
    PAYOUT_METHOD,
    PAYOUT_CURRENCY,
} = require('./referralPayoutRequest.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const {
    creditWalletDirect,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('../wallet/wallet.service');
const { createAuditLog } = require('../audit/audit.service');
const {
    REFERRAL_PAYOUT_ACTIONS,
    WALLET_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const {
    notifyReferralPayoutRequested,
    notifyReferralPayoutRejected,
    notifyReferralPayoutPaid,
} = require('../notifications/notification.service');
const { Decimal } = require('../../shared/utils/decimalPrecision');
const { BusinessRuleError, NotFoundError } = require('../../shared/errors/AppError');

const MAX_PAYOUT_TRANSACTION_ATTEMPTS = 3;
const MAX_PAYOUT_COMMISSION_COUNT = 100;

const PAYOUT_TRANSACTION_OPTIONS = Object.freeze({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
});

let payoutTestHooks = {};

const __setReferralPayoutTestHooks = (hooks = {}) => {
    payoutTestHooks = hooks || {};
};

const runPayoutTestHook = async (name, payload) => {
    if (process.env.NODE_ENV !== 'test') return;
    if (typeof payoutTestHooks[name] === 'function') {
        await payoutTestHooks[name](payload);
    }
};

const toDecimalStrict = (value, code = 'INVALID_PAYOUT_AMOUNT') => {
    try {
        const decimal = new Decimal(value);
        if (!decimal.isFinite()) throw new Error('non-finite');
        return decimal;
    } catch (_) {
        throw new BusinessRuleError('Invalid payout amount.', code);
    }
};

const toMoneyString = (value) => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

const normalizeObjectId = (value, resource = 'ObjectId') => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new BusinessRuleError(`${resource} is invalid.`, 'INVALID_OBJECT_ID');
    }
    return new mongoose.Types.ObjectId(value);
};

const uniqueSortedIds = (ids = []) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new BusinessRuleError('commissionIds must be a non-empty array.', 'EMPTY_PAYOUT_COMMISSION_LIST');
    }
    if (ids.length > MAX_PAYOUT_COMMISSION_COUNT) {
        throw new BusinessRuleError('Too many commissions in one payout request.', 'PAYOUT_COMMISSION_LIMIT_EXCEEDED');
    }

    const normalized = ids.map((id) => String(normalizeObjectId(id, 'commissionId')));
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
        throw new BusinessRuleError('Duplicate commissionIds are not allowed.', 'DUPLICATE_PAYOUT_COMMISSION_IDS');
    }
    return [...unique].sort();
};

const buildPayoutIdempotencyKey = ({ referrerId, commissionIds, method }) => {
    const hash = crypto
        .createHash('sha256')
        .update(commissionIds.join(','))
        .digest('hex');
    return `referrer:${referrerId}:commissions:${hash}:${method}:v1`;
};

const hasMongoErrorLabel = (err, label) => (
    typeof err?.hasErrorLabel === 'function'
        ? err.hasErrorLabel(label)
        : Array.isArray(err?.errorLabels) && err.errorLabels.includes(label)
);

const isMongoDuplicateKeyError = (err) => err?.code === 11000;

const isTransactionUnavailableError = (err) => {
    const message = String(err?.message || '');
    return err?.codeName === 'IllegalOperation'
        || /transaction numbers are only allowed/i.test(message)
        || /transactions are not supported/i.test(message)
        || /replica set/i.test(message)
        || /client session/i.test(message);
};

const makeReconciliationError = (classification = 'UNKNOWN') => new BusinessRuleError(
    `Referral payout requires manual reconciliation (${classification}).`,
    'PAYOUT_RECONCILIATION_REQUIRED'
);

const makeRetryExhaustedError = () => new BusinessRuleError(
    'Referral payout transaction retry attempts were exhausted.',
    'PAYOUT_RETRY_EXHAUSTED'
);

const withBoundedPayoutTransactionRetry = async (session, transactionFn) => {
    for (let attempt = 1; attempt <= MAX_PAYOUT_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
            return await session.withTransaction(transactionFn, PAYOUT_TRANSACTION_OPTIONS);
        } catch (err) {
            if (!hasMongoErrorLabel(err, 'TransientTransactionError')) throw err;
            if (attempt === MAX_PAYOUT_TRANSACTION_ATTEMPTS) throw makeRetryExhaustedError();
        }
    }
    throw makeRetryExhaustedError();
};

const getMinimumPayoutUsd = () => {
    const minimum = toDecimalStrict(config.referralPayout?.minUsd ?? '0', 'INVALID_REFERRAL_PAYOUT_CONFIG');
    if (minimum.isNegative()) {
        throw new BusinessRuleError('Referral payout minimum must be non-negative.', 'INVALID_REFERRAL_PAYOUT_CONFIG');
    }
    return minimum;
};

const sumCommissionAmounts = (commissions) => commissions.reduce(
    (sum, commission) => sum.plus(toDecimalStrict(commission.commissionAmountUsd)),
    new Decimal(0)
);

const amountsEqual = (left, right) => toMoneyString(left) === toMoneyString(right);

const sortedStringIds = (ids = []) => ids.map((id) => String(id)).sort();

const exactIdSetMatches = (left = [], right = []) => {
    const a = sortedStringIds(left);
    const b = sortedStringIds(right);
    return a.length === b.length && a.every((id, index) => id === b[index]);
};

const findPayoutWalletLedgers = async (payout, session = null) => {
    const query = WalletTransaction.find({
        userId: payout.referrerId,
        type: TRANSACTION_TYPES.CREDIT,
        sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
        sourceId: payout._id,
        operation: TRANSACTION_OPERATIONS.CREDIT,
    }).sort({ createdAt: 1 });
    if (session) query.session(session);
    return query;
};

const getPayoutCommissions = async (payout, session = null) => {
    const query = ReferralCommission.find({ _id: { $in: payout.commissionIds } }).sort({ _id: 1 });
    if (session) query.session(session);
    return query;
};

const classifyPayoutState = async (payout, session = null) => {
    if (!payout) return 'UNKNOWN';

    const commissions = await getPayoutCommissions(payout, session);
    if (commissions.length !== payout.commissionIds.length) return `${payout.status}_WITH_MISSING_COMMISSION`;
    if (!exactIdSetMatches(commissions.map((item) => item._id), payout.commissionIds)) return 'COMMISSION_SET_MISMATCH';

    const total = sumCommissionAmounts(commissions);
    if (!amountsEqual(total, payout.amountUsd)) return 'TOTAL_MISMATCH';

    if (payout.status === PAYOUT_STATUS.PENDING) {
        const healthy = commissions.every((commission) => (
            commission.status === COMMISSION_STATUS.LOCKED
            && String(commission.payoutRequestId || '') === String(payout._id)
            && String(commission.referrerId) === String(payout.referrerId)
        ));
        return healthy ? 'HEALTHY_PENDING' : 'PENDING_WITH_AVAILABLE_COMMISSION';
    }

    if (payout.status === PAYOUT_STATUS.REJECTED) {
        const healthy = commissions.every((commission) => (
            commission.status === COMMISSION_STATUS.AVAILABLE
            && !commission.payoutRequestId
            && !commission.lockedAt
        ));
        return healthy ? 'HEALTHY_REJECTED' : 'REJECTED_WITH_LOCKED_COMMISSION';
    }

    if (payout.status === PAYOUT_STATUS.PAID) {
        const paid = commissions.every((commission) => (
            commission.status === COMMISSION_STATUS.PAID
            && String(commission.payoutRequestId || '') === String(payout._id)
            && commission.paidAt
        ));
        if (!paid) return 'PAID_WITH_LOCKED_COMMISSION';

        if (payout.method === PAYOUT_METHOD.MANUAL) {
            if (!payout.externalReference) return 'PAID_MANUAL_WITHOUT_REFERENCE';
            const ledgers = await findPayoutWalletLedgers(payout, session);
            return ledgers.length === 0 ? 'HEALTHY_PAID_MANUAL' : 'PAID_MANUAL_WITH_WALLET_LEDGER';
        }

        const ledgers = await findPayoutWalletLedgers(payout, session);
        if (ledgers.length === 0) return 'PAID_WITH_MISSING_WALLET_LEDGER';
        if (ledgers.length > 1) return 'PAID_WITH_DUPLICATE_WALLET_LEDGER';
        const [ledger] = ledgers;
        if (String(ledger._id) !== String(payout.walletTransactionId || '')) return 'PAID_WITH_MISMATCHED_WALLET_LEDGER';
        if (!amountsEqual(ledger.amount, payout.amountUsd)) return 'TOTAL_MISMATCH';
        return 'HEALTHY_PAID_WALLET';
    }

    return 'UNKNOWN';
};

const assertPayoutHealthy = async (payout, expectedClassifications, session = null) => {
    const classification = await classifyPayoutState(payout, session);
    if (expectedClassifications.includes(classification)) {
        return classification;
    }
    throw makeReconciliationError(classification);
};

const fetchExistingPayoutByKey = async (idempotencyKey, session = null) => {
    const query = ReferralPayoutRequest.findOne({ idempotencyKey });
    if (session) query.session(session);
    return query;
};

const serializePayoutForUser = (payout) => ({
    id: String(payout._id || payout.id),
    status: payout.status,
    method: payout.method,
    amountUsd: payout.amountUsd,
    currency: payout.currency,
    commissionCount: payout.requestSnapshot?.commissionCount || payout.commissionIds?.length || 0,
    requestedAt: payout.requestedAt || null,
    reviewedAt: payout.reviewedAt || null,
    paidAt: payout.paidAt || null,
    rejectedAt: payout.rejectedAt || null,
    externalReferenceMasked: payout.externalReference ? `***${String(payout.externalReference).slice(-4)}` : null,
    rejectionReason: payout.rejectionReason || null,
});

const serializePayoutForAdmin = (payout) => ({
    ...serializePayoutForUser(payout),
    referrer: payout.referrerId && typeof payout.referrerId === 'object'
        ? {
            id: String(payout.referrerId._id || payout.referrerId.id),
            name: payout.referrerId.name || null,
            email: payout.referrerId.email
                ? `${String(payout.referrerId.email).slice(0, 1)}***@${String(payout.referrerId.email).split('@')[1] || ''}`
                : null,
        }
        : null,
    commissionIds: (payout.commissionIds || []).map((id) => String(id)),
    walletTransactionId: payout.walletTransactionId ? String(payout.walletTransactionId) : null,
    externalReference: payout.externalReference || null,
    manualSettlementNote: payout.manualSettlementNote || null,
});

const buildAuditContext = (auditContext, fallbackActorId, fallbackRole) => ({
    actorId: auditContext?.actorId ?? fallbackActorId,
    actorRole: auditContext?.actorRole ?? fallbackRole,
    ipAddress: auditContext?.ipAddress ?? null,
    userAgent: auditContext?.userAgent ?? null,
});

const runPostCommitEffects = ({ type, payout, actorId, auditContext, walletTransaction = null }) => {
    const ctx = buildAuditContext(auditContext, actorId || payout.referrerId, actorId ? ACTOR_ROLES.ADMIN : ACTOR_ROLES.CUSTOMER);
    const action = type === 'REQUESTED'
        ? REFERRAL_PAYOUT_ACTIONS.REQUESTED
        : type === 'REJECTED'
            ? REFERRAL_PAYOUT_ACTIONS.REJECTED
            : REFERRAL_PAYOUT_ACTIONS.PAID;

    createAuditLog({
        ...ctx,
        action,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            referrerId: String(payout.referrerId),
            amountUsd: payout.amountUsd,
            currency: payout.currency,
            method: payout.method,
            status: payout.status,
            commissionCount: payout.requestSnapshot?.commissionCount || payout.commissionIds.length,
            walletTransactionId: walletTransaction?._id?.toString?.() || payout.walletTransactionId?.toString?.() || null,
        },
    });

    if (type === 'PAID' && walletTransaction) {
        createAuditLog({
            ...ctx,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: payout.referrerId,
            metadata: {
                payoutRequestId: String(payout._id),
                amountUsd: payout.amountUsd,
                walletSourceIdentity: {
                    sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
                    sourceId: String(payout._id),
                    operation: TRANSACTION_OPERATIONS.CREDIT,
                },
            },
        });
    }

    if (type === 'REQUESTED') notifyReferralPayoutRequested(payout);
    if (type === 'REJECTED') notifyReferralPayoutRejected(payout);
    if (type === 'PAID') notifyReferralPayoutPaid(payout);
};

const startRequiredSession = async () => {
    let session;
    try {
        session = await mongoose.startSession();
    } catch (_) {
        throw new BusinessRuleError('Referral payouts require MongoDB transaction support.', 'FINANCIAL_TRANSACTION_UNAVAILABLE');
    }
    if (!session || typeof session.withTransaction !== 'function') {
        if (session) await session.endSession();
        throw new BusinessRuleError('Referral payouts require MongoDB transaction support.', 'FINANCIAL_TRANSACTION_UNAVAILABLE');
    }
    return session;
};

const createPayoutRequest = async (referrerId, { commissionIds, method }, auditContext = null) => {
    const normalizedMethod = String(method || '').trim().toUpperCase();
    if (!Object.values(PAYOUT_METHOD).includes(normalizedMethod)) {
        throw new BusinessRuleError('Unsupported payout method.', 'INVALID_PAYOUT_METHOD');
    }

    const normalizedReferrerId = normalizeObjectId(referrerId, 'referrerId');
    const sortedIds = uniqueSortedIds(commissionIds);
    const objectIds = sortedIds.map((id) => new mongoose.Types.ObjectId(id));
    const idempotencyKey = buildPayoutIdempotencyKey({
        referrerId: normalizedReferrerId,
        commissionIds: sortedIds,
        method: normalizedMethod,
    });

    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;
    let attemptCount = 0;

    try {
        result = await withBoundedPayoutTransactionRetry(session, async () => {
            attemptCount += 1;
            await runPayoutTestHook('transactionAttemptStarted', { operation: 'create', attempt: attemptCount });

            const existing = await fetchExistingPayoutByKey(idempotencyKey, session);
            if (existing) {
                await assertPayoutHealthy(existing, ['HEALTHY_PENDING'], session);
                isIdempotent = true;
                return existing;
            }

            const referrer = await User.findById(normalizedReferrerId).select('status deletedAt').session(session);
            if (!referrer) throw new NotFoundError('User');
            if (referrer.status !== USER_STATUS.ACTIVE || referrer.deletedAt) {
                throw new BusinessRuleError('Only active users can request referral payouts.', 'ACCOUNT_INACTIVE');
            }

            const commissions = await ReferralCommission.find({ _id: { $in: objectIds } }).session(session);
            if (commissions.length !== objectIds.length) {
                throw new BusinessRuleError('All selected commissions must exist.', 'INVALID_PAYOUT_COMMISSION_SET');
            }

            for (const commission of commissions) {
                if (String(commission.referrerId) !== String(normalizedReferrerId)) {
                    throw new BusinessRuleError('Selected commissions must belong to the authenticated user.', 'FOREIGN_COMMISSION');
                }
                if (commission.status !== COMMISSION_STATUS.AVAILABLE || commission.payoutRequestId) {
                    throw new BusinessRuleError('Selected commissions must be AVAILABLE and unlocked.', 'COMMISSION_NOT_AVAILABLE');
                }
                if (commission.commissionCurrency !== COMMISSION_CURRENCY) {
                    throw new BusinessRuleError('Only USD referral commissions can be paid out.', 'INVALID_COMMISSION_CURRENCY');
                }
            }

            const total = sumCommissionAmounts(commissions).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
            if (!total.greaterThan(0)) {
                throw new BusinessRuleError('Payout total must be positive.', 'INVALID_PAYOUT_TOTAL');
            }
            if (total.lessThan(getMinimumPayoutUsd())) {
                throw new BusinessRuleError('Payout total is below the configured minimum.', 'PAYOUT_BELOW_MINIMUM');
            }

            const now = new Date();
            const payoutId = new mongoose.Types.ObjectId();
            const [payout] = await ReferralPayoutRequest.create([{
                _id: payoutId,
                referrerId: normalizedReferrerId,
                commissionIds: objectIds,
                amountUsd: total.toFixed(2),
                currency: PAYOUT_CURRENCY,
                method: normalizedMethod,
                status: PAYOUT_STATUS.PENDING,
                idempotencyKey,
                requestedAt: now,
                requestSnapshot: {
                    commissionCount: objectIds.length,
                    amountUsd: total.toFixed(2),
                    currency: PAYOUT_CURRENCY,
                    commissionIds: objectIds,
                },
            }], { session });

            await runPayoutTestHook('beforeCommissionLock', { payoutId, commissionIds: sortedIds });
            const lockResult = await ReferralCommission.updateMany(
                {
                    _id: { $in: objectIds },
                    referrerId: normalizedReferrerId,
                    status: COMMISSION_STATUS.AVAILABLE,
                    payoutRequestId: null,
                },
                {
                    $set: {
                        status: COMMISSION_STATUS.LOCKED,
                        payoutRequestId: payoutId,
                        lockedAt: now,
                    },
                },
                { session }
            );
            if (lockResult.modifiedCount !== objectIds.length) {
                throw new BusinessRuleError('Selected commissions could not be locked atomically.', 'PAYOUT_LOCK_CONFLICT');
            }

            return payout;
        });
    } catch (err) {
        if (hasMongoErrorLabel(err, 'UnknownTransactionCommitResult') || isMongoDuplicateKeyError(err)) {
            const existing = await fetchExistingPayoutByKey(idempotencyKey);
            if (!existing) throw err;
            await assertPayoutHealthy(existing, ['HEALTHY_PENDING']);
            result = existing;
            isIdempotent = true;
        } else if (isTransactionUnavailableError(err)) {
            throw new BusinessRuleError('Referral payouts require MongoDB transaction support.', 'FINANCIAL_TRANSACTION_UNAVAILABLE');
        } else {
            throw err;
        }
    } finally {
        await session.endSession();
    }

    const payout = await ReferralPayoutRequest.findById(result._id);
    if (!isIdempotent) {
        runPostCommitEffects({ type: 'REQUESTED', payout, auditContext });
    }
    return payout;
};

const listPayoutsForReferrer = async (referrerId, filters = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const query = { referrerId };
    if (filters.status) query.status = String(filters.status).trim().toUpperCase();
    if (filters.method) query.method = String(filters.method).trim().toUpperCase();
    if (filters.dateFrom || filters.dateTo) {
        query.requestedAt = {};
        if (filters.dateFrom) query.requestedAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.requestedAt.$lte = new Date(filters.dateTo);
    }

    const [items, total] = await Promise.all([
        ReferralPayoutRequest.find(query).sort({ requestedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        ReferralPayoutRequest.countDocuments(query),
    ]);

    return {
        items: items.map(serializePayoutForUser),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

const getPayoutForReferrer = async (referrerId, payoutId) => {
    const payout = await ReferralPayoutRequest.findOne({ _id: payoutId, referrerId }).lean();
    if (!payout) throw new NotFoundError('ReferralPayoutRequest');
    return serializePayoutForUser(payout);
};

const listPayoutsForAdmin = async (filters = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const query = {};
    if (filters.status) query.status = String(filters.status).trim().toUpperCase();
    if (filters.method) query.method = String(filters.method).trim().toUpperCase();
    if (filters.dateFrom || filters.dateTo) {
        query.requestedAt = {};
        if (filters.dateFrom) query.requestedAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.requestedAt.$lte = new Date(filters.dateTo);
    }

    if (filters.search) {
        const regex = new RegExp(String(filters.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const users = await User.find({ $or: [{ name: regex }, { email: regex }, { referralCode: regex }] }).select('_id').lean();
        query.referrerId = { $in: users.map((user) => user._id) };
    }

    const [items, total] = await Promise.all([
        ReferralPayoutRequest.find(query)
            .populate('referrerId', 'name email referralCode')
            .sort({ requestedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        ReferralPayoutRequest.countDocuments(query),
    ]);

    return {
        items: items.map(serializePayoutForAdmin),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

const getPayoutForAdmin = async (payoutId) => {
    const payout = await ReferralPayoutRequest.findById(payoutId)
        .populate('referrerId', 'name email referralCode')
        .lean();
    if (!payout) throw new NotFoundError('ReferralPayoutRequest');
    return serializePayoutForAdmin(payout);
};

const rejectPayout = async (payoutId, adminId, { rejectionReason = null } = {}, auditContext = null) => {
    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;

    try {
        result = await withBoundedPayoutTransactionRetry(session, async () => {
            const existing = await ReferralPayoutRequest.findById(payoutId).session(session);
            if (!existing) throw new NotFoundError('ReferralPayoutRequest');
            if (existing.status === PAYOUT_STATUS.REJECTED) {
                await assertPayoutHealthy(existing, ['HEALTHY_REJECTED'], session);
                isIdempotent = true;
                return existing;
            }
            if (existing.status === PAYOUT_STATUS.PAID) {
                await assertPayoutHealthy(existing, ['HEALTHY_PAID_WALLET', 'HEALTHY_PAID_MANUAL'], session);
                throw new BusinessRuleError('Paid payout requests cannot be rejected.', 'PAYOUT_ALREADY_PAID');
            }

            const commissions = await getPayoutCommissions(existing, session);
            if (commissions.length !== existing.commissionIds.length) throw makeReconciliationError('PENDING_WITH_MISSING_COMMISSION');
            const total = sumCommissionAmounts(commissions);
            if (!amountsEqual(total, existing.amountUsd)) throw makeReconciliationError('TOTAL_MISMATCH');

            const invalid = commissions.some((commission) => (
                commission.status !== COMMISSION_STATUS.LOCKED
                || String(commission.payoutRequestId || '') !== String(existing._id)
                || String(commission.referrerId) !== String(existing.referrerId)
            ));
            if (invalid) throw makeReconciliationError('PENDING_WITH_AVAILABLE_COMMISSION');

            const now = new Date();
            const unlock = await ReferralCommission.updateMany(
                {
                    _id: { $in: existing.commissionIds },
                    referrerId: existing.referrerId,
                    status: COMMISSION_STATUS.LOCKED,
                    payoutRequestId: existing._id,
                },
                {
                    $set: { status: COMMISSION_STATUS.AVAILABLE },
                    $unset: { payoutRequestId: '', lockedAt: '' },
                },
                { session }
            );
            if (unlock.modifiedCount !== existing.commissionIds.length) throw makeReconciliationError('REJECTED_WITH_LOCKED_COMMISSION');

            existing.status = PAYOUT_STATUS.REJECTED;
            existing.reviewedBy = adminId;
            existing.reviewedAt = now;
            existing.rejectedAt = now;
            existing.rejectionReason = rejectionReason || null;
            await existing.save({ session });
            return existing;
        });
    } catch (err) {
        if (hasMongoErrorLabel(err, 'UnknownTransactionCommitResult')) {
            const existing = await ReferralPayoutRequest.findById(payoutId);
            if (!existing) throw err;
            await assertPayoutHealthy(existing, ['HEALTHY_REJECTED']);
            result = existing;
            isIdempotent = true;
        } else if (isTransactionUnavailableError(err)) {
            throw new BusinessRuleError('Referral payouts require MongoDB transaction support.', 'FINANCIAL_TRANSACTION_UNAVAILABLE');
        } else {
            throw err;
        }
    } finally {
        await session.endSession();
    }

    const payout = await ReferralPayoutRequest.findById(result._id);
    if (!isIdempotent) {
        runPostCommitEffects({ type: 'REJECTED', payout, actorId: adminId, auditContext });
    }
    return payout;
};

const settlePayout = async (payoutId, adminId, { externalReference = null, settlementNote = null } = {}, auditContext = null) => {
    let session = await startRequiredSession();
    let result;
    let walletTransaction = null;
    let isIdempotent = false;

    try {
        result = await withBoundedPayoutTransactionRetry(session, async () => {
            const existing = await ReferralPayoutRequest.findById(payoutId).session(session);
            if (!existing) throw new NotFoundError('ReferralPayoutRequest');
            if (existing.status === PAYOUT_STATUS.PAID) {
                await assertPayoutHealthy(
                    existing,
                    existing.method === PAYOUT_METHOD.WALLET ? ['HEALTHY_PAID_WALLET'] : ['HEALTHY_PAID_MANUAL'],
                    session
                );
                isIdempotent = true;
                return existing;
            }
            if (existing.status === PAYOUT_STATUS.REJECTED) {
                await assertPayoutHealthy(existing, ['HEALTHY_REJECTED'], session);
                throw new BusinessRuleError('Rejected payout requests cannot be settled.', 'PAYOUT_ALREADY_REJECTED');
            }

            if (existing.method === PAYOUT_METHOD.MANUAL) {
                const reference = String(externalReference || '').trim();
                if (!/^[A-Za-z0-9._:\-\/ ]{3,120}$/.test(reference)) {
                    throw new BusinessRuleError('A valid external reference is required for manual settlement.', 'EXTERNAL_REFERENCE_REQUIRED');
                }
                existing.externalReference = reference;
                existing.manualSettlementNote = settlementNote || null;
            }

            const commissions = await getPayoutCommissions(existing, session);
            if (commissions.length !== existing.commissionIds.length) throw makeReconciliationError('PENDING_WITH_MISSING_COMMISSION');
            const total = sumCommissionAmounts(commissions);
            if (!amountsEqual(total, existing.amountUsd)) throw makeReconciliationError('TOTAL_MISMATCH');

            const invalid = commissions.some((commission) => (
                commission.status !== COMMISSION_STATUS.LOCKED
                || String(commission.payoutRequestId || '') !== String(existing._id)
                || String(commission.referrerId) !== String(existing.referrerId)
            ));
            if (invalid) throw makeReconciliationError('PENDING_WITH_AVAILABLE_COMMISSION');

            const now = new Date();
            if (existing.method === PAYOUT_METHOD.WALLET) {
                await runPayoutTestHook('beforeWalletSettlementCredit', { payoutId: existing._id });
                const credit = await creditWalletDirect({
                    userId: existing.referrerId,
                    amount: Number(existing.amountUsd),
                    reference: existing._id,
                    description: `Referral payout #${existing._id.toString().slice(-6)}`,
                    session,
                    sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
                    sourceId: existing._id,
                    operation: TRANSACTION_OPERATIONS.CREDIT,
                    idempotencyKey: `referral-payout:${existing._id}:credit`,
                    requireSourceIdentity: true,
                });
                walletTransaction = credit.transaction;
                existing.walletTransactionId = walletTransaction._id;
            }

            const paidUpdate = await ReferralCommission.updateMany(
                {
                    _id: { $in: existing.commissionIds },
                    referrerId: existing.referrerId,
                    status: COMMISSION_STATUS.LOCKED,
                    payoutRequestId: existing._id,
                },
                { $set: { status: COMMISSION_STATUS.PAID, paidAt: now } },
                { session }
            );
            if (paidUpdate.modifiedCount !== existing.commissionIds.length) throw makeReconciliationError('PAID_WITH_LOCKED_COMMISSION');

            existing.status = PAYOUT_STATUS.PAID;
            existing.reviewedBy = adminId;
            existing.reviewedAt = now;
            existing.paidAt = now;
            await existing.save({ session });
            return existing;
        });
    } catch (err) {
        if (hasMongoErrorLabel(err, 'UnknownTransactionCommitResult') || isMongoDuplicateKeyError(err)) {
            const existing = await ReferralPayoutRequest.findById(payoutId);
            if (!existing) throw err;
            await assertPayoutHealthy(
                existing,
                existing.method === PAYOUT_METHOD.WALLET ? ['HEALTHY_PAID_WALLET'] : ['HEALTHY_PAID_MANUAL']
            );
            result = existing;
            isIdempotent = true;
        } else if (isTransactionUnavailableError(err)) {
            throw new BusinessRuleError('Referral payouts require MongoDB transaction support.', 'FINANCIAL_TRANSACTION_UNAVAILABLE');
        } else {
            throw err;
        }
    } finally {
        await session.endSession();
    }

    const payout = await ReferralPayoutRequest.findById(result._id);
    if (!isIdempotent) {
        runPostCommitEffects({ type: 'PAID', payout, actorId: adminId, auditContext, walletTransaction });
    }
    return payout;
};

module.exports = {
    MAX_PAYOUT_TRANSACTION_ATTEMPTS,
    MAX_PAYOUT_COMMISSION_COUNT,
    buildPayoutIdempotencyKey,
    classifyPayoutState,
    createPayoutRequest,
    listPayoutsForReferrer,
    getPayoutForReferrer,
    listPayoutsForAdmin,
    getPayoutForAdmin,
    rejectPayout,
    settlePayout,
    serializePayoutForUser,
    serializePayoutForAdmin,
    __setReferralPayoutTestHooks,
};
