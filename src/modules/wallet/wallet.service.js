'use strict';

const { User, USER_STATUS } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('./walletTransaction.model');
const { NotFoundError, BusinessRuleError, InsufficientFundsError } = require('../../shared/errors/AppError');

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

    const opts = session ? { new: false, session } : { new: false };

    // ── Atomic CAS: matches when user is ACTIVE and (walletBalance + creditLimit) >= amount ──
    const oldUser = await User.findOneAndUpdate(
        {
            _id: userId,
            status: USER_STATUS.ACTIVE,
            $expr: {
                $gte: [
                    { $add: ['$walletBalance', { $ifNull: ['$creditLimit', 0] }] },
                    amount,
                ],
            },
        },
        [{ $set: { walletBalance: { $subtract: ['$walletBalance', amount] } } }],
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
        const available = (user.walletBalance || 0) + (user.creditLimit || 0);
        throw new InsufficientFundsError(amount, available);
    }

    // Calculate how much was drawn from wallet vs credit
    const oldBalance = Number(oldUser.walletBalance) || 0;
    const newBalance = Number((oldBalance - amount).toFixed(2));
    const walletPortion = Math.min(amount, Math.max(0, oldBalance)); // actual wallet funds used
    const creditPortion = amount - walletPortion; // remainder came from credit line

    // ── Immutable wallet transaction record ───────────────────────────────────
    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount,
        balanceBefore: oldBalance,
        balanceAfter: newBalance,
        reference,
        description,
        session,
    });

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
const forcedDebitWallet = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const user = session
        ? await User.findById(userId).session(session)
        : await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const balanceBefore = Number(user.walletBalance) || 0;
    const balanceAfter  = parseFloat((balanceBefore - amount).toFixed(2));

    // $inc is unconditional — works even when balance is already negative
    const updateOpts = session ? { session } : {};
    await User.updateOne({ _id: userId }, { $inc: { walletBalance: -amount } }, updateOpts);

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount,
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
    const totalRefund = parseFloat((walletDeducted + creditUsedAmount).toFixed(2));
    if (totalRefund <= 0) {
        throw new BusinessRuleError('Refund amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const opts = session ? { new: false, session } : { new: false };

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [
            {
                $set: {
                    walletBalance: { $add: ['$walletBalance', walletDeducted] },
                    creditUsed: {
                        $max: [0, { $subtract: ['$creditUsed', creditUsedAmount] }],
                    },
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
        amount: walletDeducted,
        balanceBefore: oldBal,
        balanceAfter: Number((oldBal + walletDeducted).toFixed(2)),
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
const creditWalletDirect = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Credit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const opts = session ? { new: false, session } : { new: false };

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [{ $set: { walletBalance: { $add: ['$walletBalance', amount] } } }],
        opts
    );

    if (!oldUser) throw new NotFoundError('User');

    const oldBal = Number(oldUser.walletBalance) || 0;

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount,
        balanceBefore: oldBal,
        balanceAfter: Number((oldBal + amount).toFixed(2)),
        reference,
        description,
        session,
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

module.exports = { debitWalletAtomic, forcedDebitWallet, refundWalletAtomic, creditWalletDirect, getTransactionHistory };
