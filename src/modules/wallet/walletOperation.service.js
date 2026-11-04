'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { User } = require('../users/user.model');
const { WalletOperation, WALLET_OPERATION_STATUS: STATUS } = require('./walletOperation.model');
const { WalletTransaction } = require('./walletTransaction.model');
const {
    ensureAuditOutboxIndexesReady,
    makeAuditEvent,
    enqueueAuditEvents,
    deliverOneAuditEvent,
} = require('../audit/auditOutbox.service');
const { WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { BusinessRuleError, NotFoundError, InsufficientFundsError } = require('../../shared/errors/AppError');

const OWNER = `${process.pid}:${crypto.randomUUID()}`;
const LEASE_CONFIG = Number(process.env.WALLET_OPERATION_LEASE_MS);
const LEASE_MS = Number.isFinite(LEASE_CONFIG) && LEASE_CONFIG >= 100 ? LEASE_CONFIG : 30_000;
let recoveryTimer = null;
let recoveryRunning = false;
let recoveryStopping = false;
const OUTBOX_EVENT = Object.freeze({
    CREDIT: 'WALLET_CREDIT',
    DEBIT: 'WALLET_DEBIT',
    REFUND: 'WALLET_REFUND',
    ADMIN: 'ADMIN_BALANCE_ADJUSTMENT',
    DEBT: 'WALLET_DEBT_ADJUSTMENT',
    CURRENCY: 'WALLET_CURRENCY_CONVERSION',
});
const AUDIT_ACTION = Object.freeze({
    [OUTBOX_EVENT.CREDIT]: WALLET_ACTIONS.CREDIT,
    [OUTBOX_EVENT.DEBIT]: WALLET_ACTIONS.DEBIT,
    [OUTBOX_EVENT.REFUND]: WALLET_ACTIONS.REFUND,
    [OUTBOX_EVENT.ADMIN]: WALLET_ACTIONS.ADMIN_BALANCE_ADJUSTMENT,
    [OUTBOX_EVENT.DEBT]: WALLET_ACTIONS.DEBT_ADJUSTED,
    [OUTBOX_EVENT.CURRENCY]: WALLET_ACTIONS.CURRENCY_CONVERTED,
});

const ensureWalletOperationIndexesReady = async () => {
    const collection = WalletOperation.collection;
    let indexes = [];
    try { indexes = await collection.indexes(); }
    catch (error) { if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error; }
    if (!indexes.some((index) => index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1)) {
        const duplicates = await collection.aggregate([
            { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, ids: { $push: '$_id' } } },
            { $match: { count: { $gt: 1 } } }, { $limit: 50 },
        ]).toArray();
        if (duplicates.length) {
            const error = new Error('WalletOperation unique index is blocked by duplicate keys.');
            error.code = 'WALLET_OPERATION_DUPLICATE_KEYS';
            error.details = duplicates;
            throw error;
        }
        await collection.createIndex({ idempotencyKey: 1 }, { unique: true });
    }
    await ensureAuditOutboxIndexesReady();
    return { ready: true };
};

const defaultEvent = (operation) => {
    const eventType = operation.eventType || (operation.transactionType === 'CREDIT'
        ? OUTBOX_EVENT.CREDIT
        : operation.transactionType === 'REFUND'
            ? OUTBOX_EVENT.REFUND
            : operation.transactionType === 'DEBT_ADJUSTMENT'
                ? OUTBOX_EVENT.DEBT
                : OUTBOX_EVENT.DEBIT);
    return makeAuditEvent({
        eventId: `${operation.idempotencyKey}:audit:${eventType}`,
        eventType,
        actorId: operation.actorId || operation.userId,
        actorRole: operation.actorRole || ACTOR_ROLES.SYSTEM,
        action: operation.auditAction || AUDIT_ACTION[eventType],
        entityType: ENTITY_TYPES.WALLET,
        entityId: operation.userId,
        metadata: {
            walletOperationId: operation.idempotencyKey,
            operationType: operation.operationType,
            amount: operation.amount,
            currency: operation.currency,
            balanceBefore: operation.balanceBefore,
            balanceAfter: operation.balanceAfter,
            reference: operation.reference?.toString?.() || null,
            description: operation.description,
            targetCurrency: operation.targetCurrency || null,
            ...(operation.auditMetadata || {}),
        },
    });
};

const eventRecords = (operation) => operation.auditEvents?.length
    ? operation.auditEvents.map((event) => event.payload
        ? { ...event, eventId: event.eventId || `${operation.idempotencyKey}:audit:${event.eventType}` }
        : makeAuditEvent({ ...event, eventId: event.eventId || `${operation.idempotencyKey}:audit:${event.eventType}` }))
    : [defaultEvent(operation)];

const buildOperation = (input) => ({
    idempotencyKey: String(input.idempotencyKey),
    userId: input.userId,
    operationType: input.operationType,
    transactionType: input.transactionType,
    amount: Number(input.amount),
    delta: Number(input.delta),
    currency: String(input.currency || 'USD').toUpperCase(),
    reference: input.reference || null,
    description: input.description || '',
    creditUsedAfter: input.creditUsedAfter == null ? null : Number(input.creditUsedAfter),
    creditUsedMode: input.creditUsedMode || null,
    creditUsedAmount: input.creditUsedAmount == null ? null : Number(input.creditUsedAmount),
    expectedBalance: input.expectedBalance == null ? null : Number(input.expectedBalance),
    requireActiveUser: Boolean(input.requireActiveUser),
    targetBalance: input.targetBalance == null ? null : Number(input.targetBalance),
    targetCurrency: input.targetCurrency ? String(input.targetCurrency).toUpperCase() : null,
    ledgerRequired: input.ledgerRequired !== false,
    enforceAvailable: Boolean(input.enforceAvailable),
    actorId: input.actorId || null,
    actorRole: input.actorRole || null,
    eventType: input.eventType || null,
    auditAction: input.auditAction || null,
    auditMetadata: input.auditMetadata || null,
    auditEvents: input.auditEvents || [],
});

const ensureOperationRecord = async (input, session = null) => {
    const data = buildOperation(input);
    const options = { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) };
    let operation;
    try {
        operation = await WalletOperation.findOneAndUpdate(
            { idempotencyKey: data.idempotencyKey },
            { $setOnInsert: data },
            options
        );
    } catch (error) {
        if (error.code !== 11000) throw error;
        let query = WalletOperation.findOne({ idempotencyKey: data.idempotencyKey });
        if (session) query = query.session(session);
        operation = await query;
    }
    if (!operation) throw new Error('Wallet operation record could not be persisted.');
    for (const key of ['userId', 'operationType', 'transactionType', 'amount', 'delta', 'currency', 'targetCurrency', 'ledgerRequired']) {
        const expected = key === 'userId' ? String(data[key]) : data[key];
        const actual = key === 'userId' ? String(operation[key]) : operation[key];
        if (actual !== expected) throw new BusinessRuleError('Idempotency key is already used for a different wallet operation.', 'WALLET_OPERATION_KEY_CONFLICT');
    }
    if (operation.operationType === 'ADMIN_SET_BALANCE' && Number(operation.targetBalance) !== Number(data.targetBalance)) {
        throw new BusinessRuleError('Idempotency key is already used for a different target balance.', 'WALLET_OPERATION_KEY_CONFLICT');
    }
    return operation;
};

// An earlier ADMIN_CREDIT implementation persisted a balance snapshot before
// acquiring the wallet lock. A failed request could therefore leave a PREPARED
// idempotency record that permanently retried with a stale expectedBalance.
// Safely upgrade only unclaimed PREPARED credits; applied or actively leased
// operations keep their original immutable intent and recovery path.
const upgradePreparedAdminCredit = async (operation, input) => {
    if (operation.operationType !== 'ADMIN_CREDIT' || operation.status !== STATUS.PREPARED) return operation;
    const data = buildOperation(input);
    if (data.creditUsedMode !== 'ADMIN_CREDIT' || data.targetBalance != null || data.expectedBalance != null) return operation;
    const now = new Date();
    const upgraded = await WalletOperation.findOneAndUpdate(
        {
            _id: operation._id,
            status: STATUS.PREPARED,
            $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
        },
        { $set: {
            expectedBalance: null,
            targetBalance: null,
            creditUsedAfter: null,
            creditUsedMode: 'ADMIN_CREDIT',
            auditMetadata: data.auditMetadata,
        } },
        { new: true }
    );
    return upgraded || operation;
};

const createLock = (operation, token) => ({
    operationKey: operation.idempotencyKey,
    depositId: null,
    operationType: operation.operationType,
    leaseOwner: OWNER,
    leaseToken: token,
    leaseUntil: new Date(Date.now() + LEASE_MS),
    status: 'PREPARED',
    amount: operation.amount,
    delta: operation.delta,
    currency: operation.currency,
    transactionType: operation.transactionType,
    reference: operation.reference,
    description: operation.description,
    creditUsedAfter: operation.creditUsedAfter,
    creditUsedMode: operation.creditUsedMode,
    creditUsedAmount: operation.creditUsedAmount,
    expectedBalance: operation.expectedBalance,
    requireActiveUser: operation.requireActiveUser,
    targetBalance: operation.targetBalance,
    targetCurrency: operation.targetCurrency,
});

const reserveWallet = async (operation, token, session = null) => {
    let query = User.findById(operation.userId).select('+activeWalletOperation currency walletBalance creditUsed creditLimit status');
    if (session) query = query.session(session);
    const user = await query;
    if (!user) throw new NotFoundError('User');
    if (operation.requireActiveUser && user.status !== 'ACTIVE') throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
    const active = user.activeWalletOperation;
    if (active && active.operationKey !== operation.idempotencyKey) throw new BusinessRuleError('Another wallet operation is being recovered.', 'WALLET_OPERATION_PENDING');
    const expectedCurrency = active?.operationKey === operation.idempotencyKey && active.status === 'APPLIED' && operation.targetCurrency
        ? operation.targetCurrency : operation.currency;
    if (String(user.currency || 'USD').toUpperCase() !== expectedCurrency) throw new BusinessRuleError('Wallet currency changed before applying this operation.', 'WALLET_CURRENCY_CHANGED');
    if (active?.status === 'APPLIED') {
        if (active.leaseUntil > new Date() && active.leaseToken !== token) {
            throw new BusinessRuleError('Another worker owns the wallet operation lease.', 'WALLET_OPERATION_LEASE_HELD');
        }
        const filter = {
            _id: user._id,
            currency: expectedCurrency,
            'activeWalletOperation.operationKey': operation.idempotencyKey,
            'activeWalletOperation.leaseToken': active.leaseToken,
            'activeWalletOperation.status': 'APPLIED',
            ...(active.leaseToken !== token ? { $or: [
                { 'activeWalletOperation.leaseUntil': { $lte: new Date() } },
                { 'activeWalletOperation.leaseUntil': null },
            ] } : {}),
        };
        const fenced = await User.findOneAndUpdate(filter, { $set: {
            'activeWalletOperation.leaseOwner': OWNER,
            'activeWalletOperation.leaseToken': token,
            'activeWalletOperation.leaseUntil': new Date(Date.now() + LEASE_MS),
        } }, { new: true, ...(session ? { session } : {}) }).select('+activeWalletOperation');
        if (!fenced) throw new BusinessRuleError('Applied wallet lease was superseded.', 'WALLET_OPERATION_LEASE_LOST');
        return { user: fenced, alreadyApplied: true };
    }
    if (active?.leaseUntil > new Date() && active.leaseToken !== token) throw new BusinessRuleError('Another worker owns the wallet operation lease.', 'WALLET_OPERATION_LEASE_HELD');
    const filter = { _id: user._id, currency: expectedCurrency === 'USD' ? { $in: ['USD', null] } : expectedCurrency };
    if (operation.requireActiveUser) filter.status = 'ACTIVE';
    if (operation.expectedBalance != null) filter.walletBalance = operation.expectedBalance;
    // Older user documents may have the optional lock field explicitly stored
    // as null. Treat that as unlocked as well as a missing field; `$exists:false`
    // alone rejects those users with WALLET_OPERATION_LOCK_CONFLICT.
    if (!active) filter.activeWalletOperation = null;
    else {
        filter['activeWalletOperation.operationKey'] = operation.idempotencyKey;
        filter['activeWalletOperation.leaseToken'] = active.leaseToken;
        if (active.leaseToken !== token) filter.$or = [
            { 'activeWalletOperation.leaseUntil': { $lte: new Date() } },
            { 'activeWalletOperation.leaseUntil': null },
        ];
    }
    const options = { new: true, ...(session ? { session } : {}) };
    const reserved = await User.findOneAndUpdate(filter, { $set: { activeWalletOperation: createLock(operation, token) } }, options);
    if (!reserved) throw new BusinessRuleError('Wallet reservation changed while acquiring the operation lock.', 'WALLET_OPERATION_LOCK_CONFLICT');
    return { user: reserved, alreadyApplied: false };
};

const applyWalletOperation = async (operation, token, session = null) => {
    const filter = {
        _id: operation.userId,
        currency: operation.currency === 'USD' ? { $in: ['USD', null] } : operation.currency,
        'activeWalletOperation.operationKey': operation.idempotencyKey,
        'activeWalletOperation.leaseToken': token,
        'activeWalletOperation.status': 'PREPARED',
    };
    if (operation.enforceAvailable) {
        filter.$expr = { $gte: [
            { $add: ['$walletBalance', { $subtract: [{ $ifNull: ['$creditLimit', 0] }, { $ifNull: ['$creditUsed', 0] }] }] },
            Math.abs(operation.delta),
        ] };
    }
    const balanceExpression = operation.targetBalance == null
        ? (operation.creditUsedMode === 'ADMIN_CREDIT'
            ? { $round: [{ $add: [{ $ifNull: ['$walletBalance', 0] }, operation.delta] }, 2] }
            : { $add: [{ $ifNull: ['$walletBalance', 0] }, operation.delta] })
        : { $literal: operation.targetBalance };
    const nextBalance = balanceExpression;
    const update = [{ $set: {
        walletBalance: nextBalance,
        ...(operation.targetCurrency ? { currency: operation.targetCurrency } : {}),
        ...(operation.creditUsedAfter != null ? { creditUsed: operation.creditUsedAfter } : {}),
        ...(operation.creditUsedMode === 'DEBIT' ? {
            creditUsed: { $add: [
                { $ifNull: ['$creditUsed', 0] },
                { $max: [0, { $subtract: [operation.amount, { $max: [0, { $ifNull: ['$walletBalance', 0] }] }] }] },
            ] },
        } : {}),
        ...(operation.creditUsedMode === 'REFUND' ? {
            creditUsed: { $max: [0, { $subtract: [{ $ifNull: ['$creditUsed', 0] }, operation.creditUsedAmount || 0] }] },
        } : {}),
        ...(operation.creditUsedMode === 'ADMIN_CREDIT' ? {
            creditUsed: { $cond: [
                { $and: [
                    { $lt: [{ $ifNull: ['$walletBalance', 0] }, 0] },
                    { $gt: [{ $ifNull: ['$creditUsed', 0] }, 0] },
                ] },
                { $max: [0, { $subtract: [
                    { $ifNull: ['$creditUsed', 0] },
                    { $min: [operation.amount, { $ifNull: ['$creditUsed', 0] }] },
                ] }] },
                { $ifNull: ['$creditUsed', 0] },
            ] },
        } : {}),
        'activeWalletOperation.status': 'APPLIED',
        'activeWalletOperation.balanceBefore': operation.creditUsedMode === 'ADMIN_CREDIT'
            ? { $round: [{ $ifNull: ['$walletBalance', 0] }, 2] }
            : { $ifNull: ['$walletBalance', 0] },
        'activeWalletOperation.balanceAfter': nextBalance,
    } }];
    const user = await User.findOneAndUpdate(filter, update, { new: true, ...(session ? { session } : {}) })
        .select('+activeWalletOperation currency walletBalance creditUsed');
    if (!user) {
        let currentQuery = User.findById(operation.userId).select('+activeWalletOperation walletBalance creditLimit');
        if (session) currentQuery = currentQuery.session(session);
        const current = await currentQuery;
        if (!current) throw new NotFoundError('User');
        if (current.activeWalletOperation?.operationKey !== operation.idempotencyKey || current.activeWalletOperation.leaseToken !== token) {
            throw new BusinessRuleError('Wallet operation lease was superseded.', 'WALLET_OPERATION_LEASE_LOST');
        }
        if (operation.enforceAvailable) throw new InsufficientFundsError(Math.abs(operation.delta), (current.walletBalance || 0) + (current.creditLimit || 0));
        throw new BusinessRuleError('Wallet operation could not atomically update the balance.', 'WALLET_OPERATION_APPLY_CONFLICT');
    }
    return user.activeWalletOperation;
};

const upsertTransaction = async (operation, { session } = {}) => {
    if (operation.ledgerRequired === false) return null;
    const document = {
        userId: operation.userId,
        type: operation.transactionType,
        amount: operation.amount,
        balanceBefore: operation.balanceBefore,
        balanceAfter: operation.balanceAfter,
        reference: operation.reference,
        status: 'COMPLETED',
        description: operation.description,
        idempotencyKey: operation.idempotencyKey,
    };
    try {
        return await WalletTransaction.findOneAndUpdate(
            { idempotencyKey: operation.idempotencyKey },
            { $setOnInsert: document },
            { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
        );
    } catch (error) {
        if (error.code !== 11000) throw error;
        let query = WalletTransaction.findOne({ idempotencyKey: operation.idempotencyKey });
        if (session) query = query.session(session);
        return query;
    }
};

const releaseWalletLock = async (operation, token, session = null) => User.updateOne(
    {
        _id: operation.userId,
        'activeWalletOperation.operationKey': operation.idempotencyKey,
        'activeWalletOperation.status': 'APPLIED',
        ...(session ? { 'activeWalletOperation.leaseToken': token } : {}),
    },
    { $unset: { activeWalletOperation: 1 } },
    session ? { session } : {}
);

const releaseCompletedWalletLock = async (operation) => {
    const user = await User.findById(operation.userId).select('+activeWalletOperation currency');
    const active = user?.activeWalletOperation;
    if (!active || active.operationKey !== operation.idempotencyKey || active.status !== 'APPLIED') return false;
    const expectedCurrency = operation.targetCurrency || operation.currency;
    if (String(user.currency || 'USD').toUpperCase() !== String(expectedCurrency).toUpperCase()
        || Number(active.balanceAfter) !== Number(operation.balanceAfter)) return false;
    const released = await User.updateOne({
        _id: operation.userId,
        currency: expectedCurrency === 'USD' ? { $in: ['USD', null] } : expectedCurrency,
        'activeWalletOperation.operationKey': operation.idempotencyKey,
        'activeWalletOperation.status': 'APPLIED',
        'activeWalletOperation.leaseToken': active.leaseToken,
        'activeWalletOperation.balanceAfter': operation.balanceAfter,
    }, { $unset: { activeWalletOperation: 1 } });
    return released.modifiedCount === 1;
};

const executeInSession = async (operationInput, session) => {
    const operation = await ensureOperationRecord(operationInput, session);
    if (operation.status === STATUS.COMPLETED) return { operation, transaction: await upsertTransaction(operation, { session }), completed: true };
    const token = crypto.randomUUID();
    const { user } = await reserveWallet(operation, token, session);
    const applied = await applyWalletOperation(operation, token, session);
    Object.assign(operation, { balanceBefore: applied.balanceBefore, balanceAfter: applied.balanceAfter });
    await operation.save({ session });
    const transaction = await upsertTransaction(operation, { session });
    await WalletOperation.updateOne({ _id: operation._id }, { $set: { status: STATUS.LEDGER_RECORDED, balanceBefore: applied.balanceBefore, balanceAfter: applied.balanceAfter } }, { session });
    const events = eventRecords({ ...operation.toObject(), ...operationInput, balanceBefore: applied.balanceBefore, balanceAfter: applied.balanceAfter });
    await enqueueAuditEvents(events, { session });
    await WalletOperation.updateOne({ _id: operation._id }, { $set: { status: STATUS.OUTBOX_RECORDED } }, { session });
    await releaseWalletLock(operation, token, session);
    return { operation: await WalletOperation.findOne({ idempotencyKey: operation.idempotencyKey }).session(session), transaction, completed: false };
};

const resumeWalletOperation = async (operationIdOrKey, { leaseToken: preferredToken = null } = {}) => {
    await ensureWalletOperationIndexesReady();
    const selector = mongoose.isValidObjectId(operationIdOrKey) ? { _id: operationIdOrKey } : { idempotencyKey: operationIdOrKey };
    const operation = await WalletOperation.findOne(selector);
    if (!operation) throw new NotFoundError('WalletOperation');
    if (operation.status === STATUS.COMPLETED) {
        await releaseCompletedWalletLock(operation);
        return { operation, transaction: await WalletTransaction.findOne({ idempotencyKey: operation.idempotencyKey }), completed: true };
    }
    if (operation.status === STATUS.FAILED) throw new BusinessRuleError(operation.lastError || 'Wallet operation is marked for manual review.', operation.failureCode || 'WALLET_OPERATION_MANUAL_REVIEW_REQUIRED');
    const token = preferredToken || crypto.randomUUID();
    const claimed = await WalletOperation.findOneAndUpdate(
        { _id: operation._id, status: { $nin: [STATUS.COMPLETED, STATUS.FAILED] }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }, ...(preferredToken ? [{ leaseToken: preferredToken }] : [])] },
        { $set: { leaseOwner: OWNER, leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), lastError: null }, $inc: { attempts: 1 } },
        { new: true }
    );
    if (!claimed) throw new BusinessRuleError('Another worker owns this wallet operation.', 'WALLET_OPERATION_LEASE_HELD');
    try {
        let applied = null;
        if ([STATUS.PREPARED].includes(claimed.status)) {
            const reservation = await reserveWallet(claimed, token);
            if (reservation.alreadyApplied) applied = reservation.user.activeWalletOperation;
            else applied = await applyWalletOperation(claimed, token);
            const recorded = await WalletOperation.updateOne(
                { _id: claimed._id, leaseToken: token, status: STATUS.PREPARED },
                { $set: { status: STATUS.APPLIED, balanceBefore: applied.balanceBefore, balanceAfter: applied.balanceAfter } }
            );
            if (!recorded.matchedCount) throw new BusinessRuleError('Wallet operation was superseded before APPLIED checkpoint.', 'WALLET_OPERATION_LEASE_LOST');
            claimed.status = STATUS.APPLIED;
            claimed.balanceBefore = applied.balanceBefore;
            claimed.balanceAfter = applied.balanceAfter;
        } else {
            let userQuery = User.findById(claimed.userId).select('+activeWalletOperation');
            const user = await userQuery;
            if (user?.activeWalletOperation?.operationKey === claimed.idempotencyKey
                && user.activeWalletOperation.status === 'APPLIED') {
                applied = user.activeWalletOperation;
                claimed.balanceBefore = applied.balanceBefore;
                claimed.balanceAfter = applied.balanceAfter;
            } else if (![STATUS.LEDGER_RECORDED, STATUS.OUTBOX_RECORDED].includes(claimed.status)) {
                throw new BusinessRuleError('Applied wallet snapshots are unavailable for recovery.', 'WALLET_OPERATION_SNAPSHOT_MISSING');
            }
        }

        const transaction = await upsertTransaction(claimed);
        const ledger = transaction || await WalletTransaction.findOne({ idempotencyKey: claimed.idempotencyKey });
        if (claimed.ledgerRequired !== false && (!ledger || ledger.userId.toString() !== claimed.userId.toString() || ledger.type !== claimed.transactionType
            || Number(ledger.amount) !== Number(claimed.amount))) {
            throw new BusinessRuleError('WalletTransaction does not match the prepared wallet operation.', 'WALLET_OPERATION_LEDGER_MISMATCH');
        }
        await WalletOperation.updateOne({ _id: claimed._id, leaseToken: token, status: { $in: [STATUS.APPLIED, STATUS.LEDGER_RECORDED] } }, { $set: { status: STATUS.LEDGER_RECORDED } });
        const events = eventRecords(claimed);
        await enqueueAuditEvents(events);
        await WalletOperation.updateOne({ _id: claimed._id, leaseToken: token }, { $set: { status: STATUS.OUTBOX_RECORDED } });
        let allDelivered = true;
        for (const event of events) {
            const current = await require('../audit/auditOutbox.model').AuditOutbox.findOne({ eventId: event.eventId }).select('status');
            if (current?.status !== 'DELIVERED') {
                const result = await deliverOneAuditEvent(event.eventId);
                if (!result.delivered) allDelivered = false;
            }
        }
        const deliveredCount = await require('../audit/auditOutbox.model').AuditOutbox.countDocuments({ eventId: { $in: events.map((event) => event.eventId) }, status: 'DELIVERED' });
        allDelivered = allDelivered && deliveredCount === events.length;
        if (allDelivered) {
            const completed = await WalletOperation.updateOne(
                { _id: claimed._id, leaseToken: token, status: STATUS.OUTBOX_RECORDED },
                { $set: { status: STATUS.COMPLETED, completedAt: new Date(), leaseOwner: null, leaseToken: null, leaseUntil: null, lastError: null } }
            );
            if (completed.matchedCount) await releaseWalletLock(claimed, token);
        } else {
            await WalletOperation.updateOne({ _id: claimed._id, leaseToken: token }, { $set: { leaseUntil: new Date(0), lastError: 'Audit Outbox delivery is pending.' } });
            await User.updateOne(
                { _id: claimed.userId, 'activeWalletOperation.operationKey': claimed.idempotencyKey, 'activeWalletOperation.leaseToken': token },
                { $set: { 'activeWalletOperation.leaseUntil': new Date(0) } }
            );
        }
        return { operation: await WalletOperation.findById(claimed._id), transaction: ledger, completed: allDelivered };
    } catch (error) {
        const permanentPreApply = ['INSUFFICIENT_FUNDS', 'ACCOUNT_INACTIVE', 'WALLET_CURRENCY_CHANGED'].includes(error.code);
        await Promise.all([
            WalletOperation.updateOne(
                { _id: claimed._id, leaseToken: token, status: { $ne: STATUS.COMPLETED } },
                { $set: {
                    ...(permanentPreApply ? { status: STATUS.FAILED, failureCode: error.code } : { leaseUntil: new Date(0) }),
                    lastError: String(error.message || error).slice(0, 1000),
                } }
            ),
            User.updateOne(
                { _id: claimed.userId, 'activeWalletOperation.operationKey': claimed.idempotencyKey, 'activeWalletOperation.leaseToken': token, 'activeWalletOperation.status': 'PREPARED' },
                { $unset: { activeWalletOperation: 1 } }
            ),
        ]);
        throw error;
    }
};

const executeWalletOperation = async (input) => {
    await ensureWalletOperationIndexesReady();
    if (!input.idempotencyKey) throw new BusinessRuleError('Wallet operation requires an idempotency key.', 'WALLET_OPERATION_KEY_REQUIRED');
    let operation = await ensureOperationRecord(input, input.session || null);
    if (!input.session) operation = await upgradePreparedAdminCredit(operation, input);
    if (operation.status === STATUS.FAILED) throw new BusinessRuleError(operation.lastError || 'Wallet operation is marked for manual review.', operation.failureCode || 'WALLET_OPERATION_MANUAL_REVIEW_REQUIRED');
    if (input.session) return executeInSession({ ...input, idempotencyKey: operation.idempotencyKey }, input.session);
    if (operation.status === STATUS.COMPLETED) return { operation, transaction: await WalletTransaction.findOne({ idempotencyKey: operation.idempotencyKey }), completed: true };
    return resumeWalletOperation(operation.idempotencyKey);
};

const recoverPendingWalletOperations = async ({ limit = 100 } = {}) => {
    const staleLocks = await User.find({ 'activeWalletOperation.operationKey': { $exists: true }, 'activeWalletOperation.status': 'APPLIED' })
        .select('_id +activeWalletOperation currency')
        .limit(Math.min(limit, 500));
    for (const user of staleLocks) {
        const operation = await WalletOperation.findOne({ idempotencyKey: user.activeWalletOperation.operationKey, status: STATUS.COMPLETED });
        if (operation) await releaseCompletedWalletLock(operation);
    }
    const pending = await WalletOperation.find({ status: { $in: [STATUS.PREPARED, STATUS.APPLIED, STATUS.LEDGER_RECORDED, STATUS.OUTBOX_RECORDED] } })
        .sort({ createdAt: 1 }).limit(limit).select('_id').lean();
    const outcomes = await Promise.allSettled(pending.map((record) => resumeWalletOperation(record._id)));
    return { resumed: outcomes.filter((result) => result.status === 'fulfilled').length, failed: outcomes.filter((result) => result.status === 'rejected').length };
};

const startWalletOperationRecoveryWorker = ({ intervalMs = 5_000, limit = 100 } = {}) => {
    if (recoveryTimer) return;
    recoveryStopping = false;
    recoveryTimer = setInterval(async () => {
        if (recoveryStopping || recoveryRunning || mongoose.connection.readyState !== 1) return;
        recoveryRunning = true;
        try { await recoverPendingWalletOperations({ limit }); }
        catch (error) { console.error('[WalletRecovery] worker failed:', error.message); }
        finally { recoveryRunning = false; }
    }, intervalMs);
    recoveryTimer.unref?.();
};

const stopWalletOperationRecoveryWorker = async ({ timeoutMs = 8_000 } = {}) => {
    recoveryStopping = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
    if (!recoveryRunning) return;
    await new Promise((resolve) => {
        const poll = setInterval(() => {
            if (!recoveryRunning) { clearInterval(poll); clearTimeout(timeout); resolve(); }
        }, 25);
        const timeout = setTimeout(() => { clearInterval(poll); resolve(); }, timeoutMs);
    });
};

const listWalletOperationIssues = async ({ limit = 100 } = {}) => WalletOperation.find({ status: { $in: [STATUS.FAILED, STATUS.PREPARED, STATUS.APPLIED, STATUS.LEDGER_RECORDED, STATUS.OUTBOX_RECORDED] } })
    .sort({ createdAt: 1 }).limit(Math.min(limit, 500)).lean();

const listActiveWalletLocks = async ({ limit = 100 } = {}) => User.find({ 'activeWalletOperation.operationKey': { $exists: true } })
    .select('_id +activeWalletOperation currency walletBalance')
    .sort({ _id: 1 }).limit(Math.min(limit, 500)).lean();

const recordWalletOperationRepairAttempt = async (operationIdOrKey, actorId) => {
    const selector = mongoose.isValidObjectId(operationIdOrKey) ? { _id: operationIdOrKey } : { idempotencyKey: operationIdOrKey };
    const operation = await WalletOperation.findOne(selector);
    if (!operation) throw new NotFoundError('WalletOperation');
    const recorded = await WalletOperation.findOneAndUpdate(
        { _id: operation._id, repairSequence: operation.repairSequence || 0 },
        { $inc: { repairSequence: 1 } },
        { new: true }
    );
    if (!recorded) throw new BusinessRuleError('Wallet operation changed during repair request.', 'WALLET_OPERATION_REPAIR_CAS_CONFLICT');
    const attempt = recorded.repairSequence;
    const event = makeAuditEvent({
        eventId: `${operation.idempotencyKey}:repair:${attempt}`,
        eventType: 'WALLET_OPERATION_RECOVERY_ATTEMPT',
        actorId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: WALLET_ACTIONS.RECOVERY_ATTEMPT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: operation.userId,
        metadata: { operationId: operation.idempotencyKey, observedStatus: operation.status, attempt },
    });
    await enqueueAuditEvents([event]);
    await deliverOneAuditEvent(event.eventId);
    if (recorded.status === STATUS.FAILED) {
        throw new BusinessRuleError('FAILED wallet operations require evidence-based manual review; automatic balance changes are blocked.', 'WALLET_OPERATION_MANUAL_REVIEW_REQUIRED');
    }
    return resumeWalletOperation(operation.idempotencyKey);
};

module.exports = { executeWalletOperation, resumeWalletOperation, recoverPendingWalletOperations, startWalletOperationRecoveryWorker, stopWalletOperationRecoveryWorker, ensureWalletOperationIndexesReady, listWalletOperationIssues, listActiveWalletLocks, recordWalletOperationRepairAttempt, WALLET_OPERATION_STATUS: STATUS, OUTBOX_EVENT };
