'use strict';

const { User, USER_STATUS } = require('../users/user.model');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('./walletTransaction.model');
const { NotFoundError, BusinessRuleError, InsufficientFundsError } = require('../../shared/errors/AppError');

let walletTestHooks = {};

const __setWalletTestHooks = (hooks = {}) => {
    walletTestHooks = hooks || {};
};

const runWalletTestHook = async (name, payload) => {
    if (process.env.NODE_ENV !== 'test') return;
    if (typeof walletTestHooks[name] === 'function') {
        await walletTestHooks[name](payload);
    }
};

const safeRound = (value) => {
    const numberValue = Number(value) || 0;
    return Number(numberValue.toFixed(2));
};

const recalculateCreditUsed = (walletBalance, creditLimit) => {
    const balance = safeRound(walletBalance);
    const limit = Math.abs(Number(creditLimit) || 0);
    return balance < 0 ? safeRound(Math.min(Math.abs(balance), limit)) : 0;
};

const buildCreditUsedExpression = (walletBalanceExpression) => ({
    $cond: [
        { $lt: [walletBalanceExpression, 0] },
        {
            $round: [
                {
                    $min: [
                        { $abs: walletBalanceExpression },
                        { $abs: { $ifNull: ['$creditLimit', 0] } },
                    ],
                },
                2,
            ],
        },
        0,
    ],
});

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
    sourceType = null,
    sourceId = null,
    operation = null,
    idempotencyKey = null,
}) => {
    const doc = {
        userId,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        reference,
        sourceType,
        sourceId,
        operation,
        idempotencyKey,
        status: 'COMPLETED',
        description,
    };

    if (session) {
        const [txn] = await WalletTransaction.create([doc], { session });
        return txn;
    }
    return WalletTransaction.create(doc);
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
const debitWalletAtomic = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const roundedAmount = safeRound(amount);
    const opts = session ? { new: false, session } : { new: false };

    // ── Atomic CAS: matches when user is ACTIVE and (walletBalance + creditLimit) >= amount ──
    const oldUser = await User.findOneAndUpdate(
        {
            _id: userId,
            status: USER_STATUS.ACTIVE,
            $expr: {
                $gte: [
                    { $add: ['$walletBalance', { $abs: { $ifNull: ['$creditLimit', 0] } }] },
                    roundedAmount,
                ],
            },
        },
        [
            {
                $set: {
                    walletBalance: { $round: [{ $subtract: ['$walletBalance', roundedAmount] }, 2] },
                },
            },
            {
                $set: {
                    creditUsed: buildCreditUsedExpression('$walletBalance'),
                },
            },
        ],
        opts
    );

    if (!oldUser) {
        const user = session
            ? await User.findById(userId).session(session)
            : await User.findById(userId);
        if (!user) throw new NotFoundError('User');
        if (user.status !== USER_STATUS.ACTIVE) {
            throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
        }
        // Balance + credit limit is insufficient
        const available = safeRound((user.walletBalance || 0) + Math.abs(user.creditLimit || 0));
        throw new InsufficientFundsError(roundedAmount, available);
    }

    // Calculate how much was drawn from wallet vs credit
    const oldBalance = Number(oldUser.walletBalance) || 0;
    const creditLimit = Number(oldUser.creditLimit) || 0;
    const newBalance = safeRound(oldBalance - roundedAmount);
    const oldCreditUsed = recalculateCreditUsed(oldBalance, creditLimit);
    const newCreditUsed = recalculateCreditUsed(newBalance, creditLimit);
    const creditPortion = safeRound(Math.max(0, newCreditUsed - oldCreditUsed));

    // ── Immutable wallet transaction record ───────────────────────────────────
    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount: roundedAmount,
        balanceBefore: oldBalance,
        balanceAfter: newBalance,
        reference,
        description,
        session,
    });

    return { walletDeducted: roundedAmount, creditUsedAmount: creditPortion, transaction };
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
const forcedDebitWallet = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const roundedAmount = safeRound(amount);

    const user = session
        ? await User.findById(userId).session(session)
        : await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const balanceBefore = Number(user.walletBalance) || 0;
    const balanceAfter  = safeRound(balanceBefore - roundedAmount);

    // $inc is unconditional — works even when balance is already negative
    const updateOpts = session ? { session } : {};
    await User.updateOne(
        { _id: userId },
        [
            {
                $set: {
                    walletBalance: { $round: [{ $subtract: ['$walletBalance', roundedAmount] }, 2] },
                },
            },
            {
                $set: {
                    creditUsed: buildCreditUsedExpression('$walletBalance'),
                },
            },
        ],
        updateOpts
    );

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount: roundedAmount,
        balanceBefore,
        balanceAfter,
        reference,
        description,
        session,
    });

    return { transaction };
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
}) => {
    const refundAmount = safeRound(walletDeducted);
    if (refundAmount <= 0) {
        throw new BusinessRuleError('Refund amount must be greater than zero.', 'INVALID_AMOUNT');
    }
    void creditUsedAmount; // Compatibility metadata only; never added to the wallet refund amount.

    const opts = session ? { new: false, session } : { new: false };

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [
            {
                $set: {
                    walletBalance: { $round: [{ $add: ['$walletBalance', refundAmount] }, 2] },
                },
            },
            {
                $set: {
                    creditUsed: buildCreditUsedExpression('$walletBalance'),
                },
            },
        ],
        opts
    );

    if (!oldUser) throw new NotFoundError('User');

    const oldBal = Number(oldUser.walletBalance) || 0;

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.REFUND,
        amount: refundAmount,
        balanceBefore: oldBal,
        balanceAfter: safeRound(oldBal + refundAmount),
        reference,
        description,
        session,
    });

    return { transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — DIRECT CREDIT (deposit top-ups)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically credit a flat amount directly to a user's walletBalance.
 * Session is optional — works on standalone MongoDB instances.
 */
const creditWalletDirect = async ({
    userId,
    amount,
    reference = null,
    description = '',
    session,
    sourceType = null,
    sourceId = null,
    operation = TRANSACTION_OPERATIONS.CREDIT,
    idempotencyKey = null,
    requireSourceIdentity = false,
}) => {
    const roundedAmount = safeRound(amount);
    if (!Number.isFinite(roundedAmount) || roundedAmount <= 0) {
        throw new BusinessRuleError('Credit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    if (requireSourceIdentity && (!sourceType || !sourceId || !operation)) {
        throw new BusinessRuleError(
            'Wallet credit source identity is required.',
            'MISSING_WALLET_SOURCE_IDENTITY'
        );
    }

    const opts = session ? { new: false, session } : { new: false };

    const duplicateSourceClauses = [];
    if (idempotencyKey) duplicateSourceClauses.push({ idempotencyKey });
    if (sourceType && sourceId && operation) {
        duplicateSourceClauses.push({ sourceType, sourceId, operation });
    }
    if (duplicateSourceClauses.length > 0) {
        const duplicateQuery = WalletTransaction.findOne({ $or: duplicateSourceClauses }).select('_id');
        if (session) duplicateQuery.session(session);
        const existingSourceTransaction = await duplicateQuery;
        if (existingSourceTransaction) {
            throw new BusinessRuleError(
                'Wallet source operation has already been applied.',
                'DUPLICATE_WALLET_SOURCE_OPERATION'
            );
        }
    }

    await runWalletTestHook('beforeWalletCreditUpdate', {
        userId,
        amount: roundedAmount,
        reference,
        sourceType,
        sourceId,
        operation,
    });

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [
            {
                $set: {
                    walletBalance: { $round: [{ $add: ['$walletBalance', roundedAmount] }, 2] },
                },
            },
            {
                $set: {
                    creditUsed: buildCreditUsedExpression('$walletBalance'),
                },
            },
        ],
        opts
    );

    if (!oldUser) throw new NotFoundError('User');

    const oldBal = Number(oldUser.walletBalance) || 0;

    await runWalletTestHook('beforeWalletLedgerInsert', {
        userId,
        amount: roundedAmount,
        balanceBefore: oldBal,
        balanceAfter: safeRound(oldBal + roundedAmount),
        reference,
        sourceType,
        sourceId,
        operation,
    });

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount: roundedAmount,
        balanceBefore: oldBal,
        balanceAfter: safeRound(oldBal + roundedAmount),
        reference,
        description,
        session,
        sourceType,
        sourceId,
        operation,
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
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
    recalculateCreditUsed,
    __setWalletTestHooks,
};
