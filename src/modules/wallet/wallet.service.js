'use strict';

const { User, USER_STATUS } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('./walletTransaction.model');
const { NotFoundError, BusinessRuleError, InsufficientFundsError } = require('../../shared/errors/AppError');
const { Decimal } = require('../../shared/utils/decimalPrecision');
const crypto = require('crypto');
const { executeWalletOperation, OUTBOX_EVENT } = require('./walletOperation.service');
const { ACTOR_ROLES } = require('../audit/audit.constants');
const { makeAuditEvent, enqueueAuditEvents } = require('../audit/auditOutbox.service');

const noActiveWalletOperation = { activeWalletOperation: { $exists: false } };
const activeWalletOperationConflict = () => new BusinessRuleError(
    'Another wallet operation is being recovered. Retry after it completes.',
    'WALLET_OPERATION_PENDING'
);

const throwIfWalletOperationPending = async (userId, session) => {
    let query = User.findById(userId).select('+activeWalletOperation');
    if (session) query = query.session(session);
    const user = await query;
    if (user?.activeWalletOperation) throw activeWalletOperationConflict();
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an immutable WalletTransaction audit record.
 * Session is optional — works on standalone MongoDB instances.
 *
 * @private
 */
const _createTransactionRecord = async ({
    userId,
    type,
    amount,
    balanceBefore,
    balanceAfter,
    reference,
    description,
    session,
    idempotencyKey,
}) => {
    const doc = {
        userId,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        reference,
        status: 'COMPLETED',
        description,
        ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    if (session) {
        const [txn] = await WalletTransaction.create([doc], { session });
        if (idempotencyKey) await enqueueAuditEvents([makeAuditEvent({
            eventId: `${idempotencyKey}:audit:WALLET_CREDIT`, eventType: 'WALLET_CREDIT',
            actorId: userId, actorRole: ACTOR_ROLES.SYSTEM, action: 'WALLET_CREDIT',
            entityType: 'WALLET', entityId: userId,
            metadata: { idempotencyKey, transactionId: txn._id, amount, balanceBefore, balanceAfter, reason: description },
        })], { session });
        return txn;
    }
    const txn = await WalletTransaction.create(doc);
    if (idempotencyKey) await enqueueAuditEvents([makeAuditEvent({
        eventId: `${idempotencyKey}:audit:WALLET_CREDIT`, eventType: 'WALLET_CREDIT',
        actorId: userId, actorRole: ACTOR_ROLES.SYSTEM, action: 'WALLET_CREDIT',
        entityType: 'WALLET', entityId: userId,
        metadata: { idempotencyKey, transactionId: txn._id, amount, balanceBefore, balanceAfter, reason: description },
    })]);
    return txn;
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — ATOMIC DEBIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically debit a user's wallet for an order.
 *
 * CREDIT LIMIT (Overdraft) policy:
 *   - Orders proceed when (walletBalance + creditLimit) >= amount.
 *   - walletBalance CAN go negative, down to -(creditLimit).
 *   - creditUsedAmount tracks how much of the credit line was drawn.
 *
 * Uses a MongoDB aggregation-pipeline findOneAndUpdate — the balance check
 * and deduction are ONE atomic DB operation; no TOCTOU race conditions.
 *
 * Session is optional — when provided it is passed through, otherwise
 * the operation works on standalone MongoDB instances without transactions.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {number}          params.amount      - total order amount
 * @param {string|null}     params.reference   - orderId (set post-commit)
 * @param {string}          params.description
 * @param {ClientSession}   [params.session]   - optional MongoDB session
 *
 * @returns {{ walletDeducted: number, creditUsedAmount: number, transaction: WalletTransaction }}
 */
const debitWalletAtomic = async ({ userId, amount, reference = null, description = '', session, idempotencyKey, actorId, actorRole }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const wallet = await User.findById(userId).select('currency status');
    if (!wallet) throw new NotFoundError('User');
    if (wallet.status !== USER_STATUS.ACTIVE) throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
    const key = idempotencyKey || (reference ? `wallet:debit:${reference}` : `wallet:debit:${crypto.randomUUID()}`);
    const result = await executeWalletOperation({
        userId,
        idempotencyKey: key,
        operationType: 'PURCHASE_DEBIT',
        transactionType: TRANSACTION_TYPES.DEBIT,
        amount,
        delta: -amount,
        currency: wallet.currency || 'USD',
        reference,
        description,
        session,
        enforceAvailable: true,
        requireActiveUser: true,
        creditUsedMode: 'DEBIT',
        actorId: actorId || userId,
        actorRole: actorRole || ACTOR_ROLES.CUSTOMER,
        eventType: OUTBOX_EVENT.DEBIT,
    });
    const transaction = result.transaction;
    const oldBalance = Number(transaction.balanceBefore) || 0;
    const newBalance = Number(transaction.balanceAfter) || 0;
    const walletPortion = Math.min(amount, Math.max(0, oldBalance)); // actual wallet funds used
    const creditPortion = amount - walletPortion; // remainder came from credit line

    // ── Immutable wallet transaction record ───────────────────────────────────
    return { walletDeducted: amount, creditUsedAmount: creditPortion, transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 1b — FORCED DEBIT (admin override, bypasses balance guard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unconditionally debit a user's wallet — no balance or status check.
 *
 * ADMIN OVERRIDE ONLY. Used when an admin force-completes an order that was
 * previously refunded (e.g., provider executed the order despite a timeout).
 * Balance MAY go negative — this is intentional (debt).
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {number}          params.amount      - exact amount to deduct
 * @param {string|null}     params.reference   - orderId
 * @param {string}          params.description
 * @param {ClientSession}   [params.session]
 * @returns {{ transaction: WalletTransaction }}
 */
const forcedDebitWallet = async ({ userId, amount, reference = null, description = '', session, idempotencyKey, actorId, actorRole }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const user = session
        ? await User.findById(userId).select('currency +activeWalletOperation').session(session)
        : await User.findById(userId).select('currency +activeWalletOperation');
    if (!user) throw new NotFoundError('User');
    const result = await executeWalletOperation({
        userId,
        idempotencyKey: idempotencyKey || (reference ? `wallet:forced-debit:${reference}` : `wallet:forced-debit:${crypto.randomUUID()}`),
        operationType: 'FORCED_DEBIT',
        transactionType: TRANSACTION_TYPES.DEBIT,
        amount,
        delta: -amount,
        currency: user.currency || 'USD',
        reference,
        description,
        session,
        actorId: actorId || userId,
        actorRole: actorRole || ACTOR_ROLES.SYSTEM,
        eventType: OUTBOX_EVENT.DEBIT,
    });
    return { transaction: result.transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — ATOMIC REFUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically refund a user's wallet after an order failure.
 * Session is optional.
 */
const refundWalletAtomic = async ({
    userId,
    walletDeducted,
    creditUsedAmount,
    reference,
    description = '',
    session,
    idempotencyKey,
    actorId,
    actorRole,
    auditEvents,
}) => {
    const totalRefund = parseFloat((walletDeducted + creditUsedAmount).toFixed(2));
    if (totalRefund <= 0) {
        throw new BusinessRuleError('Refund amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const user = session
        ? await User.findById(userId).select('currency +activeWalletOperation').session(session)
        : await User.findById(userId).select('currency +activeWalletOperation');
    if (!user) throw new NotFoundError('User');
    const result = await executeWalletOperation({
        userId,
        idempotencyKey: idempotencyKey || (reference ? `wallet:refund:${reference}` : `wallet:refund:${crypto.randomUUID()}`),
        operationType: 'REFUND',
        transactionType: TRANSACTION_TYPES.REFUND,
        amount: walletDeducted > 0 ? walletDeducted : totalRefund,
        delta: walletDeducted,
        currency: user.currency || 'USD',
        creditUsedMode: 'REFUND',
        creditUsedAmount,
        reference,
        description,
        session,
        actorId: actorId || userId,
        actorRole: actorRole || ACTOR_ROLES.SYSTEM,
        eventType: OUTBOX_EVENT.REFUND,
        auditEvents,
    });
    return { transaction: result.transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — DIRECT CREDIT (deposit top-ups)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically credit a flat amount directly to a user's walletBalance.
 * Session is optional — works on standalone MongoDB instances.
 */
const creditWalletDirect = async ({ userId, amount, reference = null, description = '', session, idempotencyKey, expectedCurrency, activeOperationKey, activeOperationLeaseToken }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Credit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    if (!activeOperationKey) {
        const user = session
            ? await User.findById(userId).select('currency').session(session)
            : await User.findById(userId).select('currency');
        if (!user) throw new NotFoundError('User');
        const result = await executeWalletOperation({
            userId,
            idempotencyKey: idempotencyKey || (reference ? `wallet:credit:${reference}` : `wallet:credit:${crypto.randomUUID()}`),
            operationType: 'DIRECT_CREDIT',
            transactionType: TRANSACTION_TYPES.CREDIT,
            amount,
            delta: amount,
            currency: expectedCurrency || user.currency || 'USD',
            reference,
            description,
            session,
            actorId: userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            eventType: OUTBOX_EVENT.CREDIT,
        });
        return { transaction: result.transaction };
    }

    const opts = session ? { new: false, session } : { new: false };

    const filter = { _id: userId };
    if (expectedCurrency) {
        filter.currency = expectedCurrency === 'USD' ? { $in: ['USD', null] } : expectedCurrency;
    }
    if (activeOperationKey) {
        filter['activeWalletOperation.operationKey'] = activeOperationKey;
        filter['activeWalletOperation.leaseToken'] = activeOperationLeaseToken;
        filter['activeWalletOperation.status'] = 'PREPARED';
    } else {
        filter.activeWalletOperation = { $exists: false };
    }
    const updatePipeline = [{
        $set: {
            walletBalance: { $round: [{ $add: [{ $ifNull: ['$walletBalance', 0] }, amount] }, 2] },
            ...(activeOperationKey ? {
                'activeWalletOperation.status': 'APPLIED',
                'activeWalletOperation.balanceBefore': { $ifNull: ['$walletBalance', 0] },
                'activeWalletOperation.balanceAfter': { $round: [{ $add: [{ $ifNull: ['$walletBalance', 0] }, amount] }, 2] },
            } : {}),
        },
    }];
    const oldUser = await User.findOneAndUpdate(
        filter,
        updatePipeline,
        opts
    );

    if (!oldUser) {
        const user = session
            ? await User.findById(userId).select('+activeWalletOperation').session(session)
            : await User.findById(userId).select('+activeWalletOperation');
        if (!user) throw new NotFoundError('User');
        if (expectedCurrency && String(user.currency || 'USD').toUpperCase() !== expectedCurrency) {
            throw new BusinessRuleError('Wallet currency changed during deposit approval.', 'WALLET_CURRENCY_CHANGED');
        }
        if (activeOperationKey && (user.activeWalletOperation?.operationKey !== activeOperationKey
            || user.activeWalletOperation?.leaseToken !== activeOperationLeaseToken)) {
            throw activeWalletOperationConflict();
        }
        if (!activeOperationKey && user.activeWalletOperation) throw activeWalletOperationConflict();
        throw new NotFoundError('User');
    }

    const oldBal = Number(oldUser.walletBalance) || 0;

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount,
        balanceBefore: oldBal,
        balanceAfter: new Decimal(oldBal).plus(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
        reference,
        description,
        session,
        idempotencyKey,
    });

    return { transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get wallet transaction history for a user (paginated).
 */
const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return {
        transactions,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

module.exports = {
    debitWalletAtomic,
    forcedDebitWallet,
    refundWalletAtomic,
    creditWalletDirect,
    getTransactionHistory,
    noActiveWalletOperation,
    activeWalletOperationConflict,
};
