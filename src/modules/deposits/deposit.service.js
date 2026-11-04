'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { DepositRequest, DEPOSIT_STATUS } = require('./deposit.model');
const { DepositCreditGuard, DEPOSIT_CREDIT_GUARD_STATUS: GUARD_STATUS } = require('./depositCreditGuard.model');
const { User } = require('../users/user.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
// convertUsdToUserCurrency removed — deposits now credit requestedAmount directly
const {
    AppError,
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { makeAuditEvent, enqueueAuditEvents, deliverOneAuditEvent } = require('../audit/auditOutbox.service');
const { AuditOutbox } = require('../audit/auditOutbox.model');
const { notifyNewDeposit, notifyDepositApproved, notifyDepositRejected } = require('../notifications/notification.service');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const whatsappService = require('../whatsapp/whatsapp.service');

const safeParseJson = (value) => {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
};

const normalizeSenderDetails = (source = {}) => {
    const rawDetails = source.senderDetails && typeof source.senderDetails === 'object'
        ? source.senderDetails
        : safeParseJson(source.senderDetails);
    const details = rawDetails && typeof rawDetails === 'object' ? rawDetails : {};
    const value = String(
        details.value
        || source.senderDetailValue
        || source.senderWalletAddress
        || source.senderWalletNumber
        || source.transferredFromNumber
        || ''
    ).trim();

    if (!value) return null;

    const methodType = String(
        details.methodType
        || details.type
        || source.paymentMethodType
        || ''
    ).trim().toLowerCase();
    const field = String(
        details.field
        || source.senderDetailField
        || (source.senderWalletAddress ? 'senderWalletAddress' : 'senderWalletNumber')
    ).trim();
    const label = String(
        details.label
        || (field === 'senderWalletAddress' || methodType === 'usdt'
            ? 'عنوان المحفظة المحول منها'
            : 'رقم المحفظة المحول منها')
    ).trim();

    return {
        methodType: methodType.slice(0, 64),
        field: field.slice(0, 64),
        label: label.slice(0, 128),
        value: value.slice(0, 200),
    };
};

// =============================================================================
// CREATE
// =============================================================================

/**
 * Customer creates a new deposit request (multi-currency).
 *
 * Business rules:
 *   - User must exist and be ACTIVE (enforced upstream by requireActiveUser middleware).
 *   - requestedAmount must be > 0 (enforced by schema).
 *   - amountUsd is pre-calculated by the controller using the frozen exchangeRate.
 *   - No wallet credit at this stage; the request is PENDING until admin review.
 *   - Multiple concurrent PENDING deposits are allowed.
 *
 * Audit: DEPOSIT_REQUESTED — fire-and-forget after save.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string}          params.paymentMethodId
 * @param {number}          params.requestedAmount
 * @param {string}          params.currency
 * @param {number}          params.exchangeRate
 * @param {number}          params.amountUsd
 * @param {string}          params.receiptImage
 * @param {string|null}     [params.notes]
 * @param {Object|null}     [params.senderDetails]
 * @param {Object|null}     [params.auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const createDepositRequest = async ({
    userId,
    paymentMethodId,
    requestedAmount,
    currency,
    exchangeRate,
    amountUsd,
    receiptImage,
    notes = null,
    senderDetails = null,
    auditContext = null,
}) => {
    // Confirm user exists (belt-and-suspenders — middleware already checks ACTIVE)
    const user = await User.findById(userId).select('_id role name email');
    if (!user) throw new NotFoundError('User');

    const deposit = await DepositRequest.create({
        userId,
        paymentMethodId,
        requestedAmount: Number(parseFloat(requestedAmount).toFixed(2)),
        currency,
        exchangeRate,
        amountUsd: Number(parseFloat(amountUsd).toFixed(2)),
        receiptImage,
        notes,
        senderDetails,
        status: DEPOSIT_STATUS.PENDING,
    });

    // Audit: fire-and-forget
    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: DEPOSIT_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: userId.toString(),
            paymentMethodId,
            requestedAmount: deposit.requestedAmount,
            currency,
            exchangeRate,
            amountUsd: deposit.amountUsd,
            senderDetails,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    notifyNewDeposit(deposit);

    try {
        whatsappService.sendAdminNotification(
            `💰 *طلب شحن رصيد!*\nالمستخدم: ${user.name || user.email || userId}\nالمبلغ: ${deposit.requestedAmount} ${deposit.currency}\nوسيلة الدفع: ${paymentMethodId}`
        ).catch((err) => {
            console.error('WhatsApp Notification failed:', err.message);
        });
    } catch (err) {
        console.error('WhatsApp Notification failed:', err.message);
    }

    return deposit;
};

// =============================================================================
// APPROVE
// =============================================================================

/**
 * Admin approves a deposit request and credits the user's wallet with amountUsd.
 *
 * All mutations use an atomic compare-and-swap on { _id, status: PENDING }:
 *   1. Load and validate the deposit.
 *   2. Atomic findOneAndUpdate — prevents double-approval even under
 *      concurrent requests (no-op if status changed).
 *   3. Atomically credit the user's wallet with the pre-calculated amountUsd.
 *
 * Concurrency safety:
 *   findOneAndUpdate with { _id, status: PENDING } acts as a compare-and-swap.
 *   The first concurrent approve wins; the second finds no matching document
 *   (status is no longer PENDING) and throws DEPOSIT_ALREADY_APPROVED.
 *
 * Audit: DEPOSIT_APPROVED + WALLET_CREDIT — both fire-and-forget AFTER commit.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const resolveDepositCredit = async (deposit, overrides = {}) => {
    const finalAmount = Number(Number(overrides.amount ?? deposit.requestedAmount).toFixed(2));
    const finalCurrency = String(overrides.currency || deposit.currency || 'USD').toUpperCase();
    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        throw new BusinessRuleError('Deposit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const user = await User.findById(deposit.userId).select('currency');
    if (!user) throw new NotFoundError('User');
    const walletCurrency = String(user.currency || 'USD').toUpperCase();
    let amount;
    let conversionNote;
    if (finalCurrency === walletCurrency) {
        amount = finalAmount;
        conversionNote = `${finalAmount} ${finalCurrency} (direct, no conversion)`;
    } else {
        const { getConversionRate } = require('../../services/currencyConverter.service');
        const currencyOverridden = Boolean(overrides.currency);
        const amountOverridden = overrides.amount != null;
        const useFrozenUsd = !currencyOverridden && !amountOverridden && Number.isFinite(Number(deposit.amountUsd));
        const hasFrozenRate = !currencyOverridden && Number(deposit.exchangeRate) > 0;
        const fromRate = useFrozenUsd || hasFrozenRate
            ? Number(deposit.exchangeRate)
            : await getConversionRate(finalCurrency);
        const toRate = await getConversionRate(walletCurrency);
        const amountUsd = useFrozenUsd ? Number(deposit.amountUsd) : Number((finalAmount / fromRate).toFixed(6));
        amount = Number((amountUsd * toRate).toFixed(2));
        conversionNote = `${finalAmount} ${finalCurrency} → ${amountUsd} USD → ${amount} ${walletCurrency}`;
    }
    return { finalAmount, finalCurrency, walletCurrency, amount: Number(amount.toFixed(2)), conversionNote };
};

const transactionCapableTopology = () => {
    const type = mongoose.connection?.client?.topology?.description?.type;
    return type === 'ReplicaSetWithPrimary' || type === 'ReplicaSetNoPrimary' || type === 'Sharded' || type === 'LoadBalanced';
};

const depositCreditKey = (id) => `deposit:${id}:credit`;
const DEPOSIT_WALLET_LEASE_MS = 30_000;
const runtimeOwnerId = `${process.pid}:${crypto.randomUUID()}`;

const matchesDepositIdempotencyIndex = (index) => (
    index?.unique === true
    && Object.keys(index.key || {}).length === 1
    && index.key.idempotencyKey === 1
    && index.partialFilterExpression?.idempotencyKey?.$type === 'string'
);

/** Inspect and, only when duplicate keys are absent, create the standalone safety index. */
const ensureDepositIdempotencyIndexReady = async () => {
    const collection = WalletTransaction.collection;
    let indexes;
    try {
        indexes = await collection.indexes();
    } catch (error) {
        if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
        indexes = [];
    }
    if (indexes.some(matchesDepositIdempotencyIndex)) return { ready: true, created: false };

    const collectionExists = await mongoose.connection.db.listCollections(
        { name: collection.collectionName },
        { nameOnly: true }
    ).hasNext();
    const duplicateKeys = collectionExists ? await collection.aggregate([
        { $match: { idempotencyKey: { $type: 'string' } } },
        { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, transactionIds: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $project: { _id: 0, idempotencyKey: '$_id', count: 1, transactionIds: { $slice: ['$transactionIds', 20] } } },
        { $limit: 50 },
    ]).toArray() : [];

    if (duplicateKeys.length) {
        console.error('[Deposits] Unique idempotency index blocked by duplicate WalletTransaction keys:', JSON.stringify(duplicateKeys));
        return { ready: false, reason: 'DUPLICATE_IDEMPOTENCY_KEYS', duplicateKeys };
    }

    try {
        await collection.createIndex(
            { idempotencyKey: 1 },
            { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
        );
    } catch (error) {
        const afterFailure = await collection.indexes().catch(() => []);
        if (!afterFailure.some(matchesDepositIdempotencyIndex)) {
            const duplicatesAfterFailure = await collection.aggregate([
                { $match: { idempotencyKey: { $type: 'string' } } },
                { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, transactionIds: { $push: '$_id' } } },
                { $match: { count: { $gt: 1 } } },
                { $project: { _id: 0, idempotencyKey: '$_id', count: 1, transactionIds: { $slice: ['$transactionIds', 20] } } },
                { $limit: 50 },
            ]).toArray().catch(() => []);
            if (duplicatesAfterFailure.length) {
                console.error('[Deposits] Unique idempotency index build found duplicate keys:', JSON.stringify(duplicatesAfterFailure));
                return { ready: false, reason: 'DUPLICATE_IDEMPOTENCY_KEYS', duplicateKeys: duplicatesAfterFailure };
            }
            console.error('[Deposits] Unique idempotency index is unavailable:', error.message);
            return { ready: false, reason: 'INDEX_BUILD_FAILED', message: error.message };
        }
    }

    const verified = await collection.indexes();
    return verified.some(matchesDepositIdempotencyIndex)
        ? { ready: true, created: true }
        : { ready: false, reason: 'INDEX_VERIFICATION_FAILED' };
};

const assertDepositIdempotencyIndexReady = async () => {
    const readiness = await ensureDepositIdempotencyIndexReady();
    if (!readiness.ready) {
        throw new AppError(
            'Deposit approvals are temporarily blocked because the wallet idempotency index is not ready.',
            503,
            'DEPOSIT_IDEMPOTENCY_INDEX_UNAVAILABLE'
        );
    }
};

const ensureDepositCreditGuardIndexesReady = async () => {
    const collection = DepositCreditGuard.collection;
    let indexes = [];
    try { indexes = await collection.indexes(); } catch (error) {
        if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
    }
    const hasIndex = (field) => indexes.some((index) => (
        index.unique === true && Object.keys(index.key || {}).length === 1 && index.key[field] === 1
    ));
    const duplicateRows = [];
    for (const field of ['idempotencyKey', 'depositId']) {
        if (hasIndex(field)) continue;
        const groups = await collection.aggregate([
            { $group: { _id: `$${field}`, count: { $sum: 1 }, ids: { $push: '$_id' } } },
            { $match: { count: { $gt: 1 } } },
            { $project: { _id: 0, field: { $literal: field }, value: '$_id', count: 1, ids: { $slice: ['$ids', 20] } } },
            { $limit: 50 },
        ]).toArray();
        duplicateRows.push(...groups);
    }
    if (duplicateRows.length) {
        console.error('[Deposits] DepositCreditGuard unique index blocked by duplicate records:', JSON.stringify(duplicateRows));
        return { ready: false, reason: 'DUPLICATE_GUARD_KEYS', duplicateRows };
    }
    for (const field of ['idempotencyKey', 'depositId']) {
        if (!hasIndex(field)) {
            await collection.createIndex({ [field]: 1 }, { unique: true });
        }
    }
    indexes = await collection.indexes();
    return { ready: ['idempotencyKey', 'depositId'].every(hasIndex) };
};

const assertDepositCreditGuardIndexesReady = async () => {
    const readiness = await ensureDepositCreditGuardIndexesReady();
    if (!readiness.ready) {
        throw new AppError('Deposit credit guard indexes are unavailable; approval is blocked.', 503, 'DEPOSIT_GUARD_INDEX_UNAVAILABLE');
    }
};

const walletCurrencyMatch = (currency) => currency === 'USD'
    ? { $in: ['USD', null] }
    : currency;

const hasDepositReservation = (user, depositId) => (user.pendingDepositApprovals || [])
    .some((id) => id.toString() === depositId.toString());

const reserveDepositApproval = async (userId, depositId, currency, amount, session) => {
    const options = session ? { new: true, session } : { new: true };
    const operationKey = depositCreditKey(depositId);
    const reservation = {
        operationKey,
        depositId,
        leaseOwner: runtimeOwnerId,
        leaseToken: crypto.randomUUID(),
        leaseUntil: new Date(Date.now() + DEPOSIT_WALLET_LEASE_MS),
        status: 'PREPARED',
        amount,
        currency,
    };
    const reserved = await User.findOneAndUpdate(
        {
            _id: userId,
            currency: walletCurrencyMatch(currency),
            activeWalletOperation: { $exists: false },
        },
        { $set: { activeWalletOperation: reservation }, $addToSet: { pendingDepositApprovals: depositId } },
        options
    );
    if (reserved) return reservation;

    let currentQuery = User.findById(userId).select('+pendingDepositApprovals +activeWalletOperation currency');
    if (session) currentQuery = currentQuery.session(session);
    const current = await currentQuery;
    if (!current) throw new NotFoundError('User');
    if (String(current.currency || 'USD').toUpperCase() !== currency) {
        throw new AppError('Wallet currency changed while this deposit was being reviewed. Reopen the request before approving it.', 409, 'DEPOSIT_WALLET_CURRENCY_CHANGED');
    }
    if (current.activeWalletOperation) {
        const active = current.activeWalletOperation;
        if (active.operationKey !== operationKey || active.leaseUntil > new Date()) {
            throw new AppError('Another wallet operation is being recovered.', 409, 'WALLET_OPERATION_PENDING');
        }
        const reclaimed = await User.updateOne(
            {
                _id: userId,
                'activeWalletOperation.operationKey': operationKey,
                'activeWalletOperation.leaseToken': active.leaseToken,
                'activeWalletOperation.leaseUntil': { $lte: new Date() },
            },
            { $set: { activeWalletOperation: reservation }, $addToSet: { pendingDepositApprovals: depositId } },
            session ? { session } : {}
        );
        if (reclaimed.matchedCount) return reservation;
    }
    throw new AppError('Could not reserve this wallet for deposit approval. Retry the review.', 409, 'DEPOSIT_APPROVAL_RESERVATION_CONFLICT');
};

const releaseDepositApprovalReservation = async (userId, depositId, leaseToken, session) => {
    const options = session ? { session } : {};
    if (!leaseToken) return;
    return User.updateOne(
        { _id: userId, 'activeWalletOperation.operationKey': depositCreditKey(depositId), 'activeWalletOperation.leaseToken': leaseToken },
        { $pull: { pendingDepositApprovals: depositId }, $unset: { activeWalletOperation: 1 } },
        options
    );
};

const ensureDepositCreditGuard = async (deposit, amount, currency, session) => {
    const key = depositCreditKey(deposit._id);
    const options = { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) };
    try {
        const guard = await DepositCreditGuard.findOneAndUpdate(
            { idempotencyKey: key },
            { $setOnInsert: {
                idempotencyKey: key,
                depositId: deposit._id,
                userId: deposit.userId,
                amount,
                currency,
                status: GUARD_STATUS.PREPARED,
                attempts: 0,
            } },
            options
        );
        if (guard.depositId.toString() !== deposit._id.toString()
            || guard.userId.toString() !== deposit.userId.toString()
            || Number(guard.amount) !== Number(amount)
            || guard.currency !== currency) {
            throw new BusinessRuleError('Deposit credit guard does not match the frozen approval snapshot.', 'DEPOSIT_GUARD_SNAPSHOT_MISMATCH');
        }
        return guard;
    } catch (error) {
        if (error.code === 11000) {
            const existing = await DepositCreditGuard.findOne({
                $or: [{ idempotencyKey: key }, { depositId: deposit._id }],
            }).session(session || null);
            if (existing && existing.idempotencyKey === key
                && existing.depositId.toString() === deposit._id.toString()
                && existing.userId.toString() === deposit.userId.toString()
                && Number(existing.amount) === Number(amount)
                && existing.currency === currency) return existing;
            if (existing) throw new BusinessRuleError('Deposit credit guard uniqueness conflict needs manual review.', 'DEPOSIT_GUARD_IDENTITY_CONFLICT');
        }
        throw error;
    }
};

const acquireDepositGuardLease = async (guard, preferredToken = null) => {
    const deadline = Date.now() + DEPOSIT_WALLET_LEASE_MS + 2_000;
    while (Date.now() < deadline) {
        const now = new Date();
        const token = preferredToken || crypto.randomUUID();
        const leaseUntil = new Date(now.getTime() + DEPOSIT_WALLET_LEASE_MS);
        const claimed = await DepositCreditGuard.findOneAndUpdate(
            {
                _id: guard._id,
                status: { $in: [GUARD_STATUS.PREPARED, GUARD_STATUS.APPLIED] },
                $or: [
                    { leaseUntil: { $exists: false } },
                    { leaseUntil: null },
                    { leaseUntil: { $lte: now } },
                ],
            },
            { $set: { leaseOwner: runtimeOwnerId, leaseToken: token, leaseUntil, lastError: null }, $inc: { attempts: 1 } },
            { new: true }
        );
        if (claimed) return { guard: claimed, token, leaseUntil, completed: false };

        const current = await DepositCreditGuard.findById(guard._id);
        if (current?.status === GUARD_STATUS.COMPLETED) return { guard: current, completed: true };
        if (current?.status === GUARD_STATUS.FAILED) {
            throw new BusinessRuleError('Deposit credit guard requires manual recovery.', 'DEPOSIT_GUARD_FAILED');
        }
        const waitMs = current?.leaseUntil
            ? Math.max(20, Math.min(100, current.leaseUntil.getTime() - Date.now() + 10))
            : 50;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new AppError('Another worker currently owns this deposit recovery lease.', 409, 'DEPOSIT_GUARD_LEASE_HELD');
};

const acquireUserWalletLease = async (deposit, currency, amount, leaseToken, leaseUntil) => {
    const key = depositCreditKey(deposit._id);
    const current = await User.findById(deposit.userId)
        .select('+activeWalletOperation +appliedDepositCredits +pendingDepositApprovals currency');
    if (!current) throw new NotFoundError('User');
    if (String(current.currency || 'USD').toUpperCase() !== currency) {
        throw new AppError('Wallet currency changed while this deposit was awaiting recovery.', 409, 'DEPOSIT_WALLET_CURRENCY_CHANGED');
    }
    const active = current.activeWalletOperation;
    if (active && active.operationKey !== key) {
        throw new AppError('A different wallet operation must finish before this deposit can be credited.', 409, 'WALLET_OPERATION_PENDING');
    }
    if (active && active.leaseUntil && active.leaseUntil > new Date() && active.leaseToken !== leaseToken) {
        throw new AppError('Another worker still owns the wallet operation lease.', 409, 'WALLET_OPERATION_LEASE_HELD');
    }

    const filter = { _id: deposit.userId, currency: walletCurrencyMatch(currency) };
    if (!active) filter.activeWalletOperation = { $exists: false };
    else {
        filter['activeWalletOperation.operationKey'] = key;
        filter['activeWalletOperation.leaseToken'] = active.leaseToken;
        if (active.leaseToken !== leaseToken) filter['activeWalletOperation.leaseUntil'] = { $lte: new Date() };
    }
    const activeWalletOperation = {
        operationKey: key,
        depositId: deposit._id,
        leaseOwner: runtimeOwnerId,
        leaseToken,
        leaseUntil,
        status: active?.status === 'APPLIED' ? 'APPLIED' : 'PREPARED',
        amount,
        currency,
        ...(active?.status === 'APPLIED' ? {
            balanceBefore: active.balanceBefore,
            balanceAfter: active.balanceAfter,
        } : {}),
    };
    const reserved = await User.findOneAndUpdate(
        filter,
        { $set: { activeWalletOperation }, $addToSet: { pendingDepositApprovals: deposit._id } },
        { new: true }
    );
    if (!reserved) throw new AppError('Wallet operation changed while acquiring its lease.', 409, 'WALLET_OPERATION_LEASE_CONFLICT');
    // `activeWalletOperation` is select:false on User. Explicitly reload it so
    // recovery never assumes a missing lock is PREPARED.
    return User.findById(deposit.userId)
        .select('+activeWalletOperation +appliedDepositCredits +pendingDepositApprovals currency');
};

const applyDepositCreditAtomically = async (deposit, leaseToken, amount, currency) => {
    const key = depositCreditKey(deposit._id);
    const user = await User.findOneAndUpdate(
        {
            _id: deposit.userId,
            currency: walletCurrencyMatch(currency),
            'activeWalletOperation.operationKey': key,
            'activeWalletOperation.leaseToken': leaseToken,
            'activeWalletOperation.status': 'PREPARED',
            appliedDepositCredits: { $not: { $elemMatch: { depositId: deposit._id } } },
        },
        [{
            $set: {
                walletBalance: { $round: [{ $add: [{ $ifNull: ['$walletBalance', 0] }, amount] }, 2] },
                'activeWalletOperation.status': 'APPLIED',
                'activeWalletOperation.balanceBefore': { $ifNull: ['$walletBalance', 0] },
                'activeWalletOperation.balanceAfter': { $round: [{ $add: [{ $ifNull: ['$walletBalance', 0] }, amount] }, 2] },
            },
        }],
        { new: true, projection: { walletBalance: 1, appliedDepositCredits: 1, activeWalletOperation: 1 } }
    );
    return User.findById(deposit.userId)
        .select('+activeWalletOperation +appliedDepositCredits +pendingDepositApprovals currency');
};

const recordApprovalRecoveryError = async (depositId, status, error) => {
    if (error.code !== 'DEPOSIT_WALLET_CURRENCY_CHANGED' && error.code !== 'DEPOSIT_APPROVAL_SNAPSHOT_INVALID') return;
    await DepositRequest.updateOne(
        { _id: depositId, status },
        { $set: { approvalRecoveryError: error.code, approvalRecoveryErrorAt: new Date() } }
    );
};

/** Standalone-safe, resumable credit. The wallet marker and balance increment are one document update. */
const resumeDepositApproval = async (depositId, preferredLeaseToken = null) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('DepositRequest');
    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        const currentUser = await User.findById(deposit.userId).select('+activeWalletOperation');
        await releaseDepositApprovalReservation(deposit.userId, deposit._id, currentUser?.activeWalletOperation?.leaseToken);
        return { deposit, transitioned: false };
    }
    if (deposit.status !== DEPOSIT_STATUS.CREDIT_PENDING) {
        throw new BusinessRuleError('Deposit has no pending approval to resume.', 'DEPOSIT_NOT_CREDIT_PENDING');
    }

    const amount = Number(deposit.approvalCreditAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !deposit.approvalCreditCurrency) {
        const error = new BusinessRuleError('Deposit approval snapshot is incomplete.', 'DEPOSIT_APPROVAL_SNAPSHOT_INVALID');
        await recordApprovalRecoveryError(deposit._id, DEPOSIT_STATUS.CREDIT_PENDING, error);
        throw error;
    }

    const key = depositCreditKey(deposit._id);
    await assertDepositIdempotencyIndexReady();
    await assertDepositCreditGuardIndexesReady();
    const guard = await ensureDepositCreditGuard(deposit, amount, deposit.approvalCreditCurrency);
    if (guard.status === GUARD_STATUS.COMPLETED) {
        const completedDeposit = await DepositRequest.findOneAndUpdate(
            { _id: deposit._id, status: DEPOSIT_STATUS.CREDIT_PENDING },
            { $set: { status: DEPOSIT_STATUS.APPROVED, approvalRecoveryError: null, approvalRecoveryErrorAt: null } },
            { new: true }
        ) || await DepositRequest.findById(deposit._id);
        const user = await User.findById(deposit.userId).select('+activeWalletOperation');
        await releaseDepositApprovalReservation(deposit.userId, deposit._id, user?.activeWalletOperation?.leaseToken);
        return { deposit: completedDeposit, transitioned: completedDeposit.status === DEPOSIT_STATUS.APPROVED };
    }
    if (guard.status === GUARD_STATUS.FAILED) {
        throw new BusinessRuleError('Deposit credit guard requires manual recovery.', 'DEPOSIT_GUARD_FAILED');
    }

    const lease = await acquireDepositGuardLease(guard, preferredLeaseToken);
    if (lease.completed) return { deposit: await DepositRequest.findById(deposit._id), transitioned: false };
    let user;
    try {
        user = await acquireUserWalletLease(deposit, deposit.approvalCreditCurrency, amount, lease.token, lease.leaseUntil);
    } catch (error) {
        await DepositCreditGuard.updateOne(
            { _id: guard._id, leaseToken: lease.token, status: { $in: [GUARD_STATUS.PREPARED, GUARD_STATUS.APPLIED] } },
            { $set: { lastError: error.message, leaseUntil: new Date(0) } }
        );
        await recordApprovalRecoveryError(deposit._id, DEPOSIT_STATUS.CREDIT_PENDING, error);
        if (error.code === 'DEPOSIT_WALLET_CURRENCY_CHANGED') {
            await DepositCreditGuard.updateOne(
                { _id: guard._id, leaseToken: lease.token },
                { $set: { status: GUARD_STATUS.FAILED, lastError: error.message, leaseOwner: null, leaseToken: null, leaseUntil: null } }
            );
            const wallet = await User.findById(deposit.userId)
                .select('+activeWalletOperation +appliedDepositCredits');
            const markerExists = (wallet?.appliedDepositCredits || []).some((entry) => (
                entry.depositId.toString() === deposit._id.toString()
            ));
            if (!markerExists && wallet?.activeWalletOperation?.operationKey === key
                && wallet.activeWalletOperation.status === 'PREPARED') {
                await releaseDepositApprovalReservation(
                    deposit.userId,
                    deposit._id,
                    wallet.activeWalletOperation.leaseToken
                );
            }
        }
        throw error;
    }

    let active = user.activeWalletOperation;
    if (!active || active.operationKey !== key || active.leaseToken !== lease.token) {
        throw new AppError('Deposit wallet lease was not returned after reservation.', 409, 'WALLET_OPERATION_LEASE_LOST');
    }
    try {
    let marker = (user.appliedDepositCredits || []).find((item) => item.depositId.toString() === deposit._id.toString());
    if (active.status === 'PREPARED' && !marker) {
        const applied = await applyDepositCreditAtomically(deposit, lease.token, amount, deposit.approvalCreditCurrency);
        if (applied) {
            user = applied;
            active = applied.activeWalletOperation;
            marker = (applied.appliedDepositCredits || []).find((item) => item.depositId.toString() === deposit._id.toString());
        } else {
            const latest = await User.findById(deposit.userId)
                .select('+activeWalletOperation +appliedDepositCredits +pendingDepositApprovals currency');
            if (latest?.activeWalletOperation?.operationKey !== key
                || latest.activeWalletOperation.leaseToken !== lease.token) {
                throw new AppError('Deposit wallet lease was superseded before balance application.', 409, 'WALLET_OPERATION_LEASE_LOST');
            }
            user = latest;
            active = latest.activeWalletOperation;
            marker = (latest.appliedDepositCredits || []).find((item) => item.depositId.toString() === deposit._id.toString());
        }
    }

    // A marker from the legacy worker is authoritative: preserve it and never
    // add the balance again while upgrading/recovering old CREDIT_PENDING rows.
    if (!marker && active.status === 'PREPARED') {
        const error = new BusinessRuleError('Deposit wallet credit was not applied and its marker is missing.', 'DEPOSIT_CREDIT_MARKER_MISSING');
        await DepositCreditGuard.updateOne({ _id: guard._id, leaseToken: lease.token }, { $set: { lastError: error.message } });
        throw error;
    }
    if (!marker) {
        marker = { amount, balanceBefore: active.balanceBefore, balanceAfter: active.balanceAfter };
    }
    if (!Number.isFinite(Number(marker.balanceBefore)) || !Number.isFinite(Number(marker.balanceAfter))) {
        throw new BusinessRuleError('Deposit wallet operation has no valid balance snapshot.', 'DEPOSIT_CREDIT_SNAPSHOT_MISSING');
    }

    const appliedGuard = await DepositCreditGuard.updateOne(
        { _id: guard._id, leaseToken: lease.token, status: { $in: [GUARD_STATUS.PREPARED, GUARD_STATUS.APPLIED] } },
        { $set: {
            status: GUARD_STATUS.APPLIED,
            balanceBefore: marker.balanceBefore,
            balanceAfter: marker.balanceAfter,
            lastError: null,
        } }
    );
    if (!appliedGuard.modifiedCount) {
        const currentGuard = await DepositCreditGuard.findById(guard._id);
        if (currentGuard?.status !== GUARD_STATUS.APPLIED || currentGuard.leaseToken !== lease.token) {
            throw new AppError('Deposit guard lease was superseded before the APPLIED checkpoint.', 409, 'DEPOSIT_GUARD_LEASE_LOST');
        }
    }

    const transactionDoc = {
        userId: deposit.userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount,
        balanceBefore: marker.balanceBefore,
        balanceAfter: marker.balanceAfter,
        reference: deposit._id,
        status: 'COMPLETED',
        description: `Deposit #${deposit._id.toString().slice(-6)} (${deposit.requestedAmount} ${deposit.currency})`,
        idempotencyKey: key,
    };
    try {
        await WalletTransaction.findOneAndUpdate(
            { idempotencyKey: key },
            { $setOnInsert: transactionDoc },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        if (error.code !== 11000) throw error;
    }

    const ledger = await WalletTransaction.findOne({ idempotencyKey: key });
    if (!ledger || ledger.userId.toString() !== deposit.userId.toString()
        || ledger.type !== TRANSACTION_TYPES.CREDIT || Number(ledger.amount) !== amount
        || ledger.reference?.toString() !== deposit._id.toString()) {
        throw new BusinessRuleError('Deposit credit ledger does not match its approval snapshot.', 'DEPOSIT_LEDGER_MISMATCH');
    }

    const creditEvent = makeAuditEvent({
        eventId: `${key}:audit:WALLET_CREDIT`,
        eventType: 'WALLET_CREDIT',
        actorId: deposit.userId,
        actorRole: ACTOR_ROLES.SYSTEM,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: deposit.userId,
        metadata: { depositId: deposit._id.toString(), amount, currency: active.currency, balanceBefore: marker.balanceBefore, balanceAfter: marker.balanceAfter },
    });
    const approvalEvent = makeAuditEvent({
        eventId: `${key}:audit:DEPOSIT_APPROVED`,
        eventType: 'DEPOSIT_APPROVED',
        actorId: deposit.reviewedBy || deposit.userId,
        actorRole: deposit.reviewedBy ? ACTOR_ROLES.ADMIN : ACTOR_ROLES.SYSTEM,
        action: DEPOSIT_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            ...(deposit.approvalAuditMetadata || {}), userId: deposit.userId.toString(),
            finalAmount: deposit.requestedAmount, finalCurrency: deposit.currency,
            amount, currency: active.currency, walletBalanceBefore: marker.balanceBefore, walletBalanceAfter: marker.balanceAfter,
        },
    });
    await enqueueAuditEvents([creditEvent, approvalEvent]);
    for (const event of [creditEvent, approvalEvent]) {
        const auditEvent = await AuditOutbox.findOne({ eventId: event.eventId }).select('status');
        if (auditEvent?.status !== 'DELIVERED') {
            await deliverOneAuditEvent(event.eventId);
            const delivered = await AuditOutbox.exists({ eventId: event.eventId, status: 'DELIVERED' });
            if (!delivered) throw new BusinessRuleError('Deposit approval audit is pending delivery; approval will resume safely.', 'DEPOSIT_AUDIT_PENDING');
        }
    }

    const completedGuard = await DepositCreditGuard.updateOne(
        { _id: guard._id, leaseToken: lease.token, status: GUARD_STATUS.APPLIED },
        { $set: { status: GUARD_STATUS.COMPLETED, completedAt: new Date(), lastError: null, leaseOwner: null, leaseToken: null, leaseUntil: null } }
    );
    if (!completedGuard.modifiedCount) {
        const latestGuard = await DepositCreditGuard.findById(guard._id);
        if (latestGuard?.status !== GUARD_STATUS.COMPLETED) {
            throw new AppError('Deposit guard lease was superseded before completion.', 409, 'DEPOSIT_GUARD_LEASE_LOST');
        }
    }
    const completed = await DepositRequest.findOneAndUpdate(
        { _id: deposit._id, status: DEPOSIT_STATUS.CREDIT_PENDING },
        { $set: { status: DEPOSIT_STATUS.APPROVED, approvalRecoveryError: null, approvalRecoveryErrorAt: null } },
        { new: true }
    );
    const finalDeposit = completed || await DepositRequest.findById(deposit._id);
    if (finalDeposit.status !== DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError('Deposit approval could not be finalized.', 'DEPOSIT_APPROVAL_NOT_FINALIZED');
    }
    await releaseDepositApprovalReservation(deposit.userId, deposit._id, lease.token);
    return { deposit: finalDeposit, transitioned: Boolean(completed) };
    } catch (error) {
        // Make retry immediately available while retaining the wallet lock.
        // Both writes are fenced by this lease token so an old worker cannot
        // release a newer worker's lease.
        await Promise.all([
            DepositCreditGuard.updateOne(
                { _id: guard._id, leaseToken: lease.token, status: { $in: [GUARD_STATUS.PREPARED, GUARD_STATUS.APPLIED] } },
                { $set: { lastError: error.message, leaseUntil: new Date(0) } }
            ),
            User.updateOne(
                { _id: deposit.userId, 'activeWalletOperation.operationKey': key, 'activeWalletOperation.leaseToken': lease.token },
                { $set: { 'activeWalletOperation.leaseUntil': new Date(0) } }
            ),
        ]);
        throw error;
    }
};

const approveDeposit = async (depositId, adminId, adminOverrides = {}, auditContext = null) => {
    let existing = await DepositRequest.findById(depositId);
    if (!existing) throw new NotFoundError('DepositRequest');
    if (existing.status === DEPOSIT_STATUS.APPROVED) throw new BusinessRuleError('This deposit request has already been approved.', 'DEPOSIT_ALREADY_APPROVED');
    if (existing.status === DEPOSIT_STATUS.REJECTED) throw new BusinessRuleError('A rejected deposit cannot be approved. Create a new request.', 'DEPOSIT_ALREADY_REJECTED');

    if (existing.status === DEPOSIT_STATUS.CREDIT_PENDING) {
        const resumed = await resumeDepositApproval(existing._id);
        return populateDeposit(resumed.deposit);
    }

    const snapshot = await resolveDepositCredit(existing, adminOverrides);
    await assertDepositIdempotencyIndexReady();
    await assertDepositCreditGuardIndexesReady();
    const reviewTime = new Date();
    const fields = {
        reviewedBy: adminId,
        reviewedAt: reviewTime,
        approvalCreditAmount: snapshot.amount,
        approvalCreditCurrency: snapshot.walletCurrency,
        approvalConversionNote: snapshot.conversionNote,
        approvalAuditMetadata: {
            finalAmount: snapshot.finalAmount,
            finalCurrency: snapshot.finalCurrency,
            originalRequestedAmount: existing.requestedAmount,
            originalCurrency: existing.currency,
            adminOverrideApplied: !!(adminOverrides.amount != null || adminOverrides.currency),
            walletCurrency: snapshot.walletCurrency,
            walletCreditAmount: snapshot.amount,
            conversionNote: snapshot.conversionNote,
            reviewedBy: adminId.toString(),
            ipAddress: auditContext?.ipAddress ?? null,
            userAgent: auditContext?.userAgent ?? null,
        },
        approvalRecoveryError: null,
        approvalRecoveryErrorAt: null,
        ...(adminOverrides.amount != null ? { requestedAmount: snapshot.finalAmount } : {}),
        ...(adminOverrides.currency ? { currency: snapshot.finalCurrency } : {}),
        ...(adminOverrides.adminNotes ? { adminNotes: String(adminOverrides.adminNotes).trim() } : {}),
    };
    let transitioned;

    if (transactionCapableTopology()) {
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
        const reservation = await reserveDepositApproval(existing.userId, existing._id, snapshot.walletCurrency, snapshot.amount, session);
                const guard = await ensureDepositCreditGuard(existing, snapshot.amount, snapshot.walletCurrency, session);
                if (guard.status !== GUARD_STATUS.PREPARED) {
                    throw new BusinessRuleError('Deposit guard is not in a state that can be approved.', 'DEPOSIT_GUARD_STATE_CONFLICT');
                }
                const claimed = await DepositRequest.findOneAndUpdate(
                    { _id: depositId, status: DEPOSIT_STATUS.PENDING, updatedAt: existing.updatedAt },
                    { $set: { ...fields, status: DEPOSIT_STATUS.CREDIT_PENDING } },
                    { new: true, session }
                );
                if (!claimed) throw new BusinessRuleError('This deposit request has already been processed.', 'DEPOSIT_ALREADY_APPROVED');
                const credited = await creditWalletDirect({
                    userId: claimed.userId,
                    amount: snapshot.amount,
                    reference: claimed._id,
                    description: `Deposit #${claimed._id.toString().slice(-6)} (${snapshot.finalAmount} ${snapshot.finalCurrency})`,
                    idempotencyKey: depositCreditKey(claimed._id),
                    expectedCurrency: snapshot.walletCurrency,
                    activeOperationKey: reservation.operationKey,
                    activeOperationLeaseToken: reservation.leaseToken,
                    session,
                });
                const applied = await DepositCreditGuard.updateOne(
                    { _id: guard._id, status: GUARD_STATUS.PREPARED },
                    { $set: {
                        status: GUARD_STATUS.APPLIED,
                        balanceBefore: credited.transaction.balanceBefore,
                        balanceAfter: credited.transaction.balanceAfter,
                    } },
                    { session }
                );
                if (!applied.modifiedCount) throw new BusinessRuleError('Deposit guard could not record the applied credit.', 'DEPOSIT_GUARD_STATE_CONFLICT');
                const approvalAudit = makeAuditEvent({
                    eventId: `${depositCreditKey(claimed._id)}:audit:DEPOSIT_APPROVED`,
                    eventType: 'DEPOSIT_APPROVED',
                    actorId: adminId,
                    actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
                    action: DEPOSIT_ACTIONS.APPROVED,
                    entityType: ENTITY_TYPES.DEPOSIT,
                    entityId: claimed._id,
                    metadata: { ...fields.approvalAuditMetadata, userId: claimed.userId.toString(), amount: snapshot.amount, currency: snapshot.walletCurrency },
                    ipAddress: auditContext?.ipAddress ?? null,
                    userAgent: auditContext?.userAgent ?? null,
                });
                await enqueueAuditEvents([approvalAudit], { session });
                await DepositCreditGuard.updateOne(
                    { _id: guard._id, status: GUARD_STATUS.APPLIED },
                    { $set: { status: GUARD_STATUS.COMPLETED, completedAt: new Date() } },
                    { session }
                );
                const approved = await DepositRequest.findOneAndUpdate(
                    { _id: claimed._id, status: DEPOSIT_STATUS.CREDIT_PENDING },
                    { $set: { status: DEPOSIT_STATUS.APPROVED } },
                    { new: true, session }
                );
                if (!approved) throw new BusinessRuleError('Deposit approval could not be finalized.', 'DEPOSIT_APPROVAL_NOT_FINALIZED');
                await releaseDepositApprovalReservation(claimed.userId, claimed._id, reservation.leaseToken, session);
                transitioned = approved;
            });
        } catch (error) {
            await recordApprovalRecoveryError(depositId, DEPOSIT_STATUS.PENDING, error);
            if (error.code === 'DEPOSIT_GUARD_STATE_CONFLICT' || error.code === 'DEPOSIT_ALREADY_APPROVED') {
                const latest = await DepositRequest.findById(depositId);
                if (latest?.status === DEPOSIT_STATUS.APPROVED) {
                    throw new BusinessRuleError('This deposit request has already been approved.', 'DEPOSIT_ALREADY_APPROVED');
                }
                if (latest?.status === DEPOSIT_STATUS.CREDIT_PENDING) {
                    const resumed = await resumeDepositApproval(latest._id);
                    return populateDeposit(resumed.deposit);
                }
            }
            throw error;
        } finally {
            await session.endSession();
        }
    } else {
        try {
            var reservation = await reserveDepositApproval(existing.userId, existing._id, snapshot.walletCurrency, snapshot.amount);
        } catch (error) {
            await recordApprovalRecoveryError(depositId, DEPOSIT_STATUS.PENDING, error);
            throw error;
        }
        const claimed = await DepositRequest.findOneAndUpdate(
            { _id: depositId, status: DEPOSIT_STATUS.PENDING, updatedAt: existing.updatedAt },
            { $set: { ...fields, status: DEPOSIT_STATUS.CREDIT_PENDING } },
            { new: true }
        );
        if (!claimed) {
            const current = await DepositRequest.findById(depositId).select('status');
            if (current?.status === DEPOSIT_STATUS.REJECTED || current?.status === DEPOSIT_STATUS.APPROVED) {
                await releaseDepositApprovalReservation(existing.userId, existing._id, reservation?.leaseToken);
            }
            throw new BusinessRuleError('This deposit request changed during review. Refresh and retry.', 'DEPOSIT_APPROVAL_CONFLICT');
        }
        const resumed = await resumeDepositApproval(claimed._id, reservation.leaseToken);
        transitioned = resumed.transitioned ? resumed.deposit : null;
    }

    const updated = await DepositRequest.findById(depositId);
    if (transitioned) {
        for (const eventId of [`${depositCreditKey(updated._id)}:audit:WALLET_CREDIT`, `${depositCreditKey(updated._id)}:audit:DEPOSIT_APPROVED`]) {
            await deliverOneAuditEvent(eventId);
        }
        notifyDepositApproved(await populateDeposit(updated));
    }
    return populateDeposit(updated);
};

const populateDeposit = (deposit) => DepositRequest.findById(deposit._id)
    .populate('userId', 'name email avatar currency walletBalance')
    .populate('reviewedBy', 'name email');

/** Run after connecting to MongoDB so approvals interrupted on a standalone server finish after restart. */
const resumePendingDepositApprovals = async () => {
    const pending = await DepositRequest.find({ status: DEPOSIT_STATUS.CREDIT_PENDING }).select('_id').lean();
    const results = await Promise.allSettled(pending.map(({ _id }) => resumeDepositApproval(_id)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) console.error(`[Deposits] ${failures.length} approval(s) remain resumable after startup.`);
    await cleanupCompletedDepositReservations();
    return { resumed: results.length - failures.length, failed: failures.length };
};

const listDepositApprovalIssues = async ({ limit = 100 } = {}) => {
    const guards = await DepositCreditGuard.find({ status: { $ne: GUARD_STATUS.COMPLETED } })
        .sort({ createdAt: 1 }).limit(Math.min(500, limit)).lean();
    const pendingDeposits = await DepositRequest.find({ status: DEPOSIT_STATUS.CREDIT_PENDING })
        .sort({ updatedAt: 1 }).limit(Math.min(500, limit)).select('_id userId status approvalRecoveryError approvalRecoveryErrorAt').lean();
    return { guards, pendingDeposits };
};

const repairDepositApproval = async (depositId, actorId) => {
    const guard = await DepositCreditGuard.findOne({ depositId });
    if (!guard) throw new NotFoundError('DepositCreditGuard');
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit || deposit.status !== DEPOSIT_STATUS.CREDIT_PENDING) {
        throw new BusinessRuleError('Only a CREDIT_PENDING deposit can be resumed.', 'DEPOSIT_REPAIR_STATE_CONFLICT');
    }
    const user = await User.findById(guard.userId).select('+activeWalletOperation +appliedDepositCredits currency');
    if (!user || String(user.currency || 'USD').toUpperCase() !== guard.currency
        || Number(deposit.approvalCreditAmount) !== Number(guard.amount)
        || String(deposit.approvalCreditCurrency || '').toUpperCase() !== guard.currency) {
        throw new BusinessRuleError('Deposit amount or wallet currency does not match the recovery guard.', 'DEPOSIT_REPAIR_SNAPSHOT_MISMATCH');
    }
    const marker = (user.appliedDepositCredits || []).find((entry) => String(entry.depositId) === String(depositId));
    const active = user.activeWalletOperation;
    const activeApplied = active?.operationKey === guard.idempotencyKey && active.status === 'APPLIED';
    const proof = marker || (activeApplied ? {
        amount: active.amount, balanceBefore: active.balanceBefore, balanceAfter: active.balanceAfter,
    } : null);
    const transaction = await WalletTransaction.findOne({ idempotencyKey: guard.idempotencyKey });
    if (guard.status === GUARD_STATUS.FAILED) {
        if (!proof && !transaction
            && (!active || (active.operationKey === guard.idempotencyKey && active.status === 'PREPARED'))
            && /currency changed/i.test(guard.lastError || '')) {
            const reset = await DepositCreditGuard.updateOne(
                { _id: guard._id, status: GUARD_STATUS.FAILED, attempts: guard.attempts, lastError: guard.lastError },
                { $set: { status: GUARD_STATUS.PREPARED, lastError: null, leaseOwner: null, leaseToken: null, leaseUntil: null }, $inc: { attempts: 1 } }
            );
            if (!reset.modifiedCount) throw new BusinessRuleError('FAILED deposit guard changed while preparing a safe retry.', 'DEPOSIT_REPAIR_CAS_CONFLICT');
        } else {
            if (!proof || Number(proof.amount) !== Number(guard.amount)
            || !Number.isFinite(Number(proof.balanceBefore)) || !Number.isFinite(Number(proof.balanceAfter))) {
                throw new BusinessRuleError('FAILED guard has no atomic wallet marker proving whether the balance was applied; manual ledger review is required.', 'DEPOSIT_REPAIR_EVIDENCE_INSUFFICIENT');
            }
            if (transaction && (transaction.type !== TRANSACTION_TYPES.CREDIT
            || Number(transaction.amount) !== Number(guard.amount)
                || String(transaction.reference) !== String(depositId))) {
                throw new BusinessRuleError('Wallet transaction conflicts with the failed guard snapshot.', 'DEPOSIT_REPAIR_LEDGER_MISMATCH');
            }
            const repaired = await DepositCreditGuard.updateOne(
                { _id: guard._id, status: GUARD_STATUS.FAILED, attempts: guard.attempts },
                { $set: { status: GUARD_STATUS.APPLIED, balanceBefore: proof.balanceBefore, balanceAfter: proof.balanceAfter, lastError: null, leaseOwner: null, leaseToken: null, leaseUntil: null }, $inc: { attempts: 1 } }
            );
            if (!repaired.modifiedCount) throw new BusinessRuleError('Deposit guard changed during repair; reload the issue.', 'DEPOSIT_REPAIR_CAS_CONFLICT');
        }
    } else {
        if (![GUARD_STATUS.PREPARED, GUARD_STATUS.APPLIED, GUARD_STATUS.COMPLETED].includes(guard.status)) {
            throw new BusinessRuleError('Deposit guard is not in a repairable state.', 'DEPOSIT_REPAIR_STATE_CONFLICT');
        }
        const attempt = await DepositCreditGuard.updateOne(
            {
                _id: guard._id, status: guard.status, attempts: guard.attempts,
                ...(guard.status === GUARD_STATUS.COMPLETED ? {} : { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] }),
            },
            { $inc: { attempts: 1 } }
        );
        if (!attempt.modifiedCount) throw new BusinessRuleError('Another worker owns this deposit recovery lease.', 'DEPOSIT_GUARD_LEASE_HELD');
    }
    const eventId = `${guard.idempotencyKey}:repair:${guard.attempts + 1}`;
    await enqueueAuditEvents([makeAuditEvent({
        eventId, eventType: 'WALLET_RECOVERY_ATTEMPT', actorId, actorRole: ACTOR_ROLES.ADMIN,
        action: WALLET_ACTIONS.RECOVERY_ATTEMPT, entityType: ENTITY_TYPES.DEPOSIT, entityId: depositId,
        metadata: { depositId: String(depositId), guardStatus: guard.status, hasMarker: Boolean(proof), hasTransaction: Boolean(transaction) },
    })]);
    await deliverOneAuditEvent(eventId);
    return resumeDepositApproval(depositId);
};

const cleanupCompletedDepositReservations = async () => {
    const users = await User.find({
        'pendingDepositApprovals.0': { $exists: true },
    }).select('_id +pendingDepositApprovals').lean();
    for (const user of users) {
        const reservationIds = user.pendingDepositApprovals || [];
        const ids = [...new Set(reservationIds.map((id) => id.toString()))];
        if (!ids.length) continue;
        const terminal = await DepositRequest.find({
            _id: { $in: ids },
            status: { $in: [DEPOSIT_STATUS.APPROVED, DEPOSIT_STATUS.REJECTED] },
        }).select('_id status').lean();
        const terminalIds = terminal.map((item) => item._id);
        const pull = {};
        if (terminalIds.length) pull.pendingDepositApprovals = { $in: terminalIds };
        if (Object.keys(pull).length) await User.updateOne({ _id: user._id }, { $pull: pull });
    }

    const lockedUsers = await User.find({ 'activeWalletOperation.depositId': { $exists: true, $ne: null } })
        .select('_id +activeWalletOperation +appliedDepositCredits +pendingDepositApprovals')
        .lean();
    for (const user of lockedUsers) {
        const operation = user.activeWalletOperation;
        const deposit = await DepositRequest.findById(operation.depositId).select('status');
        const guard = await DepositCreditGuard.findOne({ idempotencyKey: operation.operationKey }).select('status leaseUntil');
        const markerApplied = (user.appliedDepositCredits || []).some((entry) => entry.depositId.toString() === operation.depositId.toString());
        const stale = !operation.leaseUntil || operation.leaseUntil <= new Date();
        const safeToClear = !deposit
            || deposit.status === DEPOSIT_STATUS.REJECTED
            || (deposit.status === DEPOSIT_STATUS.APPROVED && guard?.status === GUARD_STATUS.COMPLETED)
            || (deposit.status === DEPOSIT_STATUS.PENDING && operation.status === 'PREPARED' && !markerApplied && stale);
        if (safeToClear) {
            await User.updateOne(
                { _id: user._id, 'activeWalletOperation.operationKey': operation.operationKey, 'activeWalletOperation.leaseToken': operation.leaseToken },
                { $unset: { activeWalletOperation: 1 }, $pull: { pendingDepositApprovals: operation.depositId } }
            );
            if (guard?.status === GUARD_STATUS.PREPARED && stale) {
                await DepositCreditGuard.updateOne(
                    { idempotencyKey: operation.operationKey, leaseToken: operation.leaseToken },
                    { $set: { leaseOwner: null, leaseToken: null, leaseUntil: null } }
                );
            }
        }
    }
};

let depositRecoveryInterval = null;
let depositRecoveryRunning = false;
const startDepositRecoveryWorker = ({ intervalMs = 15_000 } = {}) => {
    if (depositRecoveryInterval) return;
    depositRecoveryInterval = setInterval(async () => {
        if (depositRecoveryRunning || mongoose.connection.readyState !== 1) return;
        depositRecoveryRunning = true;
        try { await resumePendingDepositApprovals(); }
        catch (error) { console.error('[Deposits] Recovery worker failed:', error.message); }
        finally { depositRecoveryRunning = false; }
    }, intervalMs);
    depositRecoveryInterval.unref?.();
};
const stopDepositRecoveryWorker = async ({ timeoutMs = 8_000 } = {}) => {
    if (depositRecoveryInterval) clearInterval(depositRecoveryInterval);
    depositRecoveryInterval = null;
    if (!depositRecoveryRunning) return;
    await new Promise((resolve) => {
        const poll = setInterval(() => {
            if (!depositRecoveryRunning) { clearInterval(poll); clearTimeout(timeout); resolve(); }
        }, 25);
        const timeout = setTimeout(() => { clearInterval(poll); resolve(); }, timeoutMs);
    });
};

// =============================================================================
// REJECT
// =============================================================================

/**
 * Admin rejects a deposit request.
 *
 * Only PENDING requests can be rejected.
 * No financial operation is performed — wallet is untouched.
 *
 * Audit: DEPOSIT_REJECTED — fire-and-forget after save.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {string|null}     [adminNotes]      - optional reason for rejection
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const rejectDeposit = async (depositId, adminId, adminNotes = null, auditContext = null) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('DepositRequest');

    if (deposit.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }
    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved deposit cannot be rejected. It has already been credited.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    const rejected = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: {
            status: DEPOSIT_STATUS.REJECTED,
            reviewedBy: adminId,
            reviewedAt: new Date(),
            ...(adminNotes ? { adminNotes } : {}),
        } },
        { new: true }
    );
    if (!rejected) {
        throw new BusinessRuleError('Deposit is no longer pending review.', 'DEPOSIT_NOT_PENDING');
    }
    const currentUser = await User.findById(rejected.userId).select('+activeWalletOperation');
    await releaseDepositApprovalReservation(rejected.userId, rejected._id, currentUser?.activeWalletOperation?.leaseToken);

    // Audit: fire-and-forget after save
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: rejected._id,
        metadata: {
            userId: rejected.userId.toString(),
            requestedAmount: rejected.requestedAmount,
            currency: rejected.currency,
            amountUsd: rejected.amountUsd,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    // Notification: fire-and-forget
    notifyDepositRejected(rejected, adminNotes);

    return rejected;
};

// =============================================================================
// QUERIES
// =============================================================================

/**
 * Admin: list deposit requests with optional status filter, paginated.
 * Sorted newest-first so the most recent requests appear on Page 1.
 */
const listDeposits = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    // Enforce uppercase to match DEPOSIT_STATUS enum (PENDING, APPROVED, REJECTED)
    if (status) filter.status = String(status).toUpperCase();

    // Search by user name or email
    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;

    const [deposits, total, summaryStats] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('reviewedBy', 'name email'),
        DepositRequest.countDocuments(filter),
        // Base stats — always unfiltered so dashboard cards remain stable
        DepositRequest.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.APPROVED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0 }),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalDeposits: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
        },
    };
};

/**
 * Customer: list their own deposit requests, paginated.
 * Sorted newest-first.
 */
const listMyDeposits = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Get a single deposit request by ID.
 * Customers may only see their own; admins may see any.
 *
 * @param {string|ObjectId}      depositId
 * @param {string|ObjectId|null} [requestingUserId] - if set, enforces ownership
 */
const getDepositById = async (depositId, requestingUserId = null) => {
    const deposit = await DepositRequest.findById(depositId)
        .populate('userId', 'name email')
        .populate('reviewedBy', 'name email');

    if (!deposit) throw new NotFoundError('DepositRequest');

    if (requestingUserId && deposit.userId._id.toString() !== requestingUserId.toString()) {
        throw new AuthorizationError('You do not have permission to view this deposit request.');
    }

    return deposit;
};

// =============================================================================
// UPDATE PENDING DEPOSIT
// =============================================================================

/**
 * Update a PENDING deposit request (admin editing fields).
 *
 * Guard: strictly rejects updates if the deposit is NOT in PENDING status.
 *
 * @param {string}          depositId
 * @param {Object}          data
 * @param {number}          [data.requestedAmount]
 * @param {string|ObjectId} adminId
 *
 * @returns {Promise<DepositRequest>}
 */
const updatePendingDeposit = async (depositId, data, adminId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('Deposit request');

    if (deposit.status !== DEPOSIT_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot update a ${deposit.status.toLowerCase()} deposit. Only PENDING deposits can be edited.`,
            'DEPOSIT_NOT_PENDING'
        );
    }

    const before = {
        requestedAmount: deposit.requestedAmount,
    };

    const update = {};
    if (data.requestedAmount !== undefined) {
        update.requestedAmount = Number(parseFloat(data.requestedAmount).toFixed(2));
        update.amountUsd = Number((update.requestedAmount / deposit.exchangeRate).toFixed(2));
    }
    const updated = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: update },
        { new: true }
    );
    if (!updated) throw new BusinessRuleError('Deposit is no longer pending review.', 'DEPOSIT_NOT_PENDING');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: updated._id,
        metadata: {
            before,
            after: {
                requestedAmount: updated.requestedAmount,
                amountUsd: updated.amountUsd,
            },
        },
    });

    return deposit;
};

module.exports = {
    createDepositRequest,
    approveDeposit,
    resumeDepositApproval,
    resumePendingDepositApprovals,
    listDepositApprovalIssues,
    repairDepositApproval,
    startDepositRecoveryWorker,
    stopDepositRecoveryWorker,
    ensureDepositIdempotencyIndexReady,
    assertDepositCreditGuardIndexesReady,
    rejectDeposit,
    listDeposits,
    listMyDeposits,
    getDepositById,
    updatePendingDeposit,
    normalizeSenderDetails,
};
