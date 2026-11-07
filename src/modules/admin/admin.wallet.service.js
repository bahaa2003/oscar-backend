'use strict';

/**
 * admin.wallet.service.js
 *
 * Admin manual wallet adjustments.
 *
 * Uses sequential await operations — compatible with standalone MongoDB
 * instances (no replica set required).
 */

const { User } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const crypto = require('crypto');
const { executeWalletOperation, OUTBOX_EVENT } = require('../wallet/walletOperation.service');
const { WalletOperation } = require('../wallet/walletOperation.model');

const MAX_ADJUSTMENT = 100_000;  // guard against fat-finger typos

/**
 * Safe rounding via integer math — kills IEEE-754 dust like 5.684e-14.
 * Number.toFixed(2) still leaks because it returns a string that Number()
 * re-parses, preserving intermediate float imprecision.
 */
const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

const stableAdminOperationKey = (userId, type, amount, reason, balanceBefore, callerKey) => callerKey
    || `admin-wallet:${crypto.createHash('sha256').update(JSON.stringify([String(userId), type, amount, reason || '', balanceBefore])).digest('hex')}`;

// ─── List wallets (summary of all users) ─────────────────────────────────────

const listWallets = async ({ page = 1, limit = 20 } = {}) => {
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find({ deletedAt: null })
            .select('name email walletBalance creditLimit creditUsed currency role status')
            .sort({ walletBalance: -1 })
            .skip(skip)
            .limit(limit),
        User.countDocuments({ deletedAt: null }),
    ]);

    return { wallets: users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Get one user's wallet ─────────────────────────────────────────────────────

const getWallet = async (userId) => {
    const user = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status');
    if (!user) throw new NotFoundError('User');

    // Fetch recent transactions WITH populated references so the frontend
    // store is never overwritten with unpopulated/missing transaction data.
    const recentTransactions = await WalletTransaction.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('reference', 'orderNumber customerInput status totalPrice');

    return { user, recentTransactions };
};

// ─── Transaction history ───────────────────────────────────────────────────────

const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const user = await User.findById(userId).select('_id');
    if (!user) throw new NotFoundError('User');

    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return { transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Manual Add ───────────────────────────────────────────────────────────────

/**
 * Admin: add funds to a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 * The admin dashboard displays balances in local currency, so the input
 * is naturally in the same denomination.
 *
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const addFunds = async (userId, amount, reason, adminId, idempotencyKey = null) => {
    const parsedAmount = safeRound(Number(amount));

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Read the wallet currency and construct the idempotency key. The actual
    // balance and credit repayment are computed atomically by the wallet
    // operation after it owns the user's wallet reservation.
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceSnapshotForKey = safeRound(user.walletBalance || 0);

    const result = await executeWalletOperation({
        userId,
        idempotencyKey: stableAdminOperationKey(userId, 'ADD', parsedAmount, reason, balanceSnapshotForKey, idempotencyKey),
        operationType: 'ADMIN_CREDIT', transactionType: TRANSACTION_TYPES.CREDIT,
        amount: parsedAmount, delta: parsedAmount, targetBalance: null, expectedBalance: null,
        creditUsedMode: 'ADMIN_CREDIT', currency: userCurrency, description: reason || `Admin manual credit (${userCurrency})`,
        actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, eventType: OUTBOX_EVENT.ADMIN,
        auditAction: require('../audit/audit.constants').WALLET_ACTIONS.ADMIN_BALANCE_ADJUSTMENT,
        auditMetadata: {
            type: 'ADD',
            amount: parsedAmount,
            currency: userCurrency,
            reason,
            userId,
        },
    });
    return { transaction: result.transaction };
};

/**
 * Admin: deduct funds from a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 *
 * CREDIT LIMIT ENFORCEMENT:
 *   A negative walletBalance already represents drawn credit; creditUsed is
 *   deducted separately only when it exceeds that reflected debt.
 *   Deduction allowed only if: amount <= available
 *   newBalance = walletBalance - amount (can go negative up to -creditLimit)
 */
const deductFunds = async (userId, amount, reason, adminId, idempotencyKey = null) => {
    const parsedAmount = safeRound(Number(amount));

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Fetch user to check credit limit
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
    const creditUsedBefore = safeRound(user.creditUsed || 0);
    const independentlyUsedCredit = Math.max(0, creditUsedBefore - Math.max(0, -balanceBefore));
    const totalAvailable = safeRound(balanceBefore + creditLimit - independentlyUsedCredit);
    const availableCredit = safeRound(totalAvailable - Math.max(0, balanceBefore));

    // An explicit key may refer to a debit that already consumed the last
    // available funds. Let the wallet operation validate and replay that key.
    const existingOperation = idempotencyKey
        ? await WalletOperation.exists({ idempotencyKey })
        : null;
    if (!existingOperation && parsedAmount > totalAvailable) {
        throw new BusinessRuleError(
            `Insufficient funds. Available: ${totalAvailable.toFixed(2)} ${userCurrency} ` +
            `(balance: ${balanceBefore.toFixed(2)}, available credit: ${availableCredit.toFixed(2)}).`,
            'INSUFFICIENT_BALANCE'
        );
    }

    // Calculate new balance and credit usage
    const balanceAfter = safeRound(balanceBefore - parsedAmount);

    // Only the additional negative balance consumes more of the credit line.
    // Counting the full deficit again would double-count an existing debt.
    const creditDrawn = safeRound(Math.max(0, -balanceAfter) - Math.max(0, -balanceBefore));
    const creditUsedAfter = safeRound(creditUsedBefore + creditDrawn);

    const result = await executeWalletOperation({
        userId,
        idempotencyKey: stableAdminOperationKey(userId, 'DEDUCT', parsedAmount, reason, balanceBefore, idempotencyKey),
        operationType: 'ADMIN_DEBIT', transactionType: TRANSACTION_TYPES.DEBIT,
        amount: parsedAmount, delta: -parsedAmount, targetBalance: balanceAfter, expectedBalance: balanceBefore,
        creditUsedAfter, enforceAvailable: true, currency: userCurrency, description: reason || `Admin manual debit (${userCurrency})`,
        actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, eventType: OUTBOX_EVENT.ADMIN,
        auditAction: require('../audit/audit.constants').WALLET_ACTIONS.ADMIN_BALANCE_ADJUSTMENT,
        auditMetadata: {
            type: 'DEDUCT',
            amount: parsedAmount,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter,
            creditDrawn,
            creditUsedBefore,
            creditUsedAfter,
        },
    });
    return { transaction: result.transaction };
};

// ─── Admin Force Set Balance ──────────────────────────────────────────────────

/**
 * Admin: forcefully set a user's wallet balance to an exact value.
 *
 * This bypasses credit limit checks — it is an admin override.
 * The amount parameter IS the desired new balance (can be negative).
 * Credit usage is recalculated based on the new balance.
 */
const setBalance = async (userId, targetBalance, reason, adminId, idempotencyKey = null) => {
    const newBalance = safeRound(Number(targetBalance));

    if (!Number.isFinite(newBalance)) {
        throw new BusinessRuleError('Target balance must be a valid number.', 'INVALID_AMOUNT');
    }

    if (Math.abs(newBalance) > MAX_ADJUSTMENT * 10) {
        throw new BusinessRuleError(
            `Target balance magnitude exceeds maximum (${MAX_ADJUSTMENT * 10}).`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));

    // Recalculate credit usage based on the new balance
    // If newBalance < 0, creditUsed = min(|newBalance|, creditLimit)
    const creditUsedAfter = newBalance < 0
        ? safeRound(Math.min(Math.abs(newBalance), creditLimit))
        : 0;

    // Determine transaction type based on direction
    const delta = safeRound(newBalance - balanceBefore);
    if (delta === 0) return { transaction: null, user: { walletBalance: newBalance, creditUsed: creditUsedAfter } };
    const txType = delta >= 0 ? TRANSACTION_TYPES.CREDIT : TRANSACTION_TYPES.DEBIT;

    const result = await executeWalletOperation({
        userId,
        idempotencyKey: stableAdminOperationKey(userId, 'SET', newBalance, reason, balanceBefore, idempotencyKey),
        operationType: 'ADMIN_SET_BALANCE', transactionType: txType,
        amount: safeRound(Math.abs(delta)), delta, targetBalance: newBalance, expectedBalance: balanceBefore,
        creditUsedAfter, currency: userCurrency, description: reason || `Admin set balance to ${newBalance} (${userCurrency})`,
        actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, eventType: OUTBOX_EVENT.ADMIN,
        auditAction: require('../audit/audit.constants').WALLET_ACTIONS.ADMIN_BALANCE_ADJUSTMENT,
        auditMetadata: {
            type: 'SET',
            targetBalance: newBalance,
            delta,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter: newBalance,
            creditUsedAfter,
        },
    });
    return { transaction: result.transaction, user: { walletBalance: newBalance, creditUsed: creditUsedAfter } };
};

// ─── Bulk Debt Adjustment (Currency Devaluation) ─────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage increase to account
 * for currency devaluation (debt pegging).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageIncrease / 100)
 *   newBalance = walletBalance - adjustment  (more negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the deduction.
 *
 * @param {number} percentageIncrease - e.g. 5 for a 5% devaluation
 * @param {string|ObjectId} adminId       - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by (e.g. 'EGP')
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForInflation = async (percentageIncrease, adminId, currencyCode = null, idempotencyKey = crypto.randomUUID()) => {
    if (percentageIncrease <= 0 || percentageIncrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageIncrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            const balanceAfter = safeRound(balanceBefore - adjustment);
            const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
            const creditUsedBefore = safeRound(user.creditUsed || 0);

            // Recalculate credit usage: if balance goes deeper negative,
            // creditUsed increases by the adjustment (capped at creditLimit)
            const creditUsedAfter = balanceAfter < 0
                ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
                : 0;

            await executeWalletOperation({
                userId: user._id, idempotencyKey: `${idempotencyKey}:${user._id}`,
                operationType: 'BULK_DEBT_INFLATION', transactionType: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                amount: adjustment, delta: -adjustment, targetBalance: balanceAfter, expectedBalance: balanceBefore,
                creditUsedAfter, currency: user.currency || 'USD',
                description: `Debt adjustment due to ${currencyCode || 'currency'} rate increase (${percentageIncrease}%)`,
                actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, eventType: OUTBOX_EVENT.DEBT,
                auditMetadata: { percentageIncrease, currencyCode, type: 'BULK_DEBT_ADJUSTMENT' },
            });


            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_ADJUSTMENT',
            percentageIncrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
    });
    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

// ─── Bulk Debt Relief (Currency Appreciation) ────────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage decrease to account
 * for currency appreciation (debt relief).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageDecrease / 100)
 *   newBalance = walletBalance + adjustment  (less negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the credit.
 *
 * @param {number} percentageDecrease - e.g. 5 for a 5% appreciation
 * @param {string|ObjectId} adminId   - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForDeflation = async (percentageDecrease, adminId, currencyCode = null, idempotencyKey = crypto.randomUUID()) => {
    if (percentageDecrease <= 0 || percentageDecrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageDecrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            // ADD the adjustment (debt relief — balance moves toward 0)
            const balanceAfter = safeRound(balanceBefore + adjustment);
            const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));

            // Recalculate credit usage
            const creditUsedAfter = balanceAfter < 0
                ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
                : 0;

            await executeWalletOperation({
                userId: user._id, idempotencyKey: `${idempotencyKey}:${user._id}`,
                operationType: 'BULK_DEBT_DEFLATION', transactionType: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                amount: adjustment, delta: adjustment, targetBalance: balanceAfter, expectedBalance: balanceBefore,
                creditUsedAfter, currency: user.currency || 'USD',
                description: `Debt relief due to ${currencyCode || 'currency'} rate decrease (${percentageDecrease}%)`,
                actorId: adminId, actorRole: ACTOR_ROLES.ADMIN, eventType: OUTBOX_EVENT.DEBT,
                auditMetadata: { percentageDecrease, currencyCode, type: 'BULK_DEBT_DEFLATION' },
            });

            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_DEFLATION',
            percentageDecrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
    });

    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

module.exports = {
    listWallets,
    getWallet,
    getTransactionHistory,
    addFunds,
    deductFunds,
    setBalance,
    adjustNegativeBalancesForInflation,
    adjustNegativeBalancesForDeflation,
};
