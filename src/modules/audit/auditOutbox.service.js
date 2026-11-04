'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AuditOutbox, AUDIT_OUTBOX_STATUS } = require('./auditOutbox.model');
const { AuditLog } = require('./audit.model');
const { ALL_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('./audit.constants');

const OWNER = `${process.pid}:${crypto.randomUUID()}`;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 20;
let workerTimer = null;
let workerRunning = false;
let workerStopping = false;
let workerIdleWaiters = [];

const ensureAuditOutboxIndexesReady = async () => {
    const outbox = AuditOutbox.collection;
    const audit = AuditLog.collection;
    const ensureUnique = async (collection, field) => {
        let indexes = [];
        try { indexes = await collection.indexes(); }
        catch (error) {
            if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
        }
        if (indexes.some((index) => index.unique && Object.keys(index.key || {}).length === 1 && index.key[field] === 1)) return true;
        const duplicates = await collection.aggregate([
            { $match: { [field]: { $type: 'string' } } },
            { $group: { _id: `$${field}`, count: { $sum: 1 }, ids: { $push: '$_id' } } },
            { $match: { count: { $gt: 1 } } },
            { $limit: 50 },
        ]).toArray();
        if (duplicates.length) {
            const error = new Error(`Unique ${field} index blocked by duplicate records.`);
            error.code = 'AUDIT_OUTBOX_DUPLICATE_EVENT_IDS';
            error.details = duplicates;
            throw error;
        }
        await collection.createIndex({ [field]: 1 }, {
            unique: true,
            ...(field === 'eventId' && collection.collectionName === 'auditlogs'
                ? { partialFilterExpression: { eventId: { $type: 'string' } } }
                : {}),
        });
        indexes = await collection.indexes();
        return indexes.some((index) => index.unique && Object.keys(index.key || {}).length === 1 && index.key[field] === 1);
    };
    const outboxReady = await ensureUnique(outbox, 'eventId');
    const auditReady = await ensureUnique(audit, 'eventId');
    if (!outboxReady || !auditReady) throw new Error('Audit Outbox eventId indexes are not ready.');
    return { ready: true };
};

const makeAuditEvent = ({
    eventId,
    eventType,
    actorId,
    actorRole = ACTOR_ROLES.SYSTEM,
    action,
    entityType,
    entityId = null,
    metadata = null,
    ipAddress = null,
    userAgent = null,
}) => ({
    eventId,
    eventType,
    payload: { actorId, actorRole, action, entityType, entityId, metadata, ipAddress, userAgent },
});

const enqueueAuditEvents = async (events, { session } = {}) => {
    for (const event of events || []) {
        if (!event?.eventId || !event?.eventType || !event?.payload) throw new Error('Outbox event is missing its deterministic identity or payload.');
        const options = { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) };
        let record;
        try {
            record = await AuditOutbox.findOneAndUpdate(
                { eventId: event.eventId },
                { $setOnInsert: { ...event, status: AUDIT_OUTBOX_STATUS.PENDING } },
                options
            );
        } catch (error) {
            if (error.code !== 11000) throw error;
            record = await AuditOutbox.findOne({ eventId: event.eventId }).session(session || null);
        }
        if (!record) throw new Error(`Outbox event ${event.eventId} could not be persisted.`);
        if (record.eventType !== event.eventType) throw new Error(`Outbox event identity conflict for ${event.eventId}.`);
    }
    return events || [];
};

const writeFinalAuditLog = async (event) => {
    const payload = event.payload;
    if (!ALL_ACTIONS.includes(payload.action)) throw new Error(`Unknown audit action '${payload.action}'.`);
    if (!Object.values(ENTITY_TYPES).includes(payload.entityType)) throw new Error(`Unknown audit entity '${payload.entityType}'.`);
    const document = {
        eventId: event.eventId,
        actorId: payload.actorId,
        actorRole: payload.actorRole,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId || null,
        metadata: payload.metadata || null,
        ipAddress: payload.ipAddress || null,
        userAgent: payload.userAgent || null,
        createdAt: new Date(),
    };
    try {
        await AuditLog.collection.updateOne({ eventId: event.eventId }, { $setOnInsert: document }, { upsert: true });
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
    const existing = await AuditLog.findOne({ eventId: event.eventId }).lean();
    if (!existing || existing.action !== payload.action || existing.entityType !== payload.entityType) {
        throw new Error(`Final AuditLog does not match Outbox event ${event.eventId}.`);
    }
    return existing;
};

const deliverOneAuditEvent = async (eventId = null) => {
    const now = new Date();
    const token = crypto.randomUUID();
    const filter = {
        ...(eventId ? { eventId } : {}),
        $or: [
            { status: AUDIT_OUTBOX_STATUS.PENDING, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
            { status: AUDIT_OUTBOX_STATUS.FAILED, attempts: { $lt: MAX_ATTEMPTS }, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
            { status: AUDIT_OUTBOX_STATUS.PROCESSING, leaseUntil: { $lte: now } },
        ],
    };
    const claimed = await AuditOutbox.findOneAndUpdate(
        filter,
        { $set: { status: AUDIT_OUTBOX_STATUS.PROCESSING, leaseOwner: OWNER, leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), lastError: null }, $inc: { attempts: 1 } },
        { new: true, sort: { createdAt: 1 } }
    );
    if (!claimed) return { claimed: false, delivered: false };
    try {
        await writeFinalAuditLog(claimed);
        const result = await AuditOutbox.updateOne(
            { _id: claimed._id, status: AUDIT_OUTBOX_STATUS.PROCESSING, leaseToken: token },
            { $set: { status: AUDIT_OUTBOX_STATUS.DELIVERED, deliveredAt: new Date(), leaseOwner: null, leaseToken: null, leaseUntil: null, lastError: null } }
        );
        return { claimed: true, delivered: result.modifiedCount === 1 };
    } catch (error) {
        const terminal = claimed.attempts >= MAX_ATTEMPTS;
        await AuditOutbox.updateOne(
            { _id: claimed._id, status: AUDIT_OUTBOX_STATUS.PROCESSING, leaseToken: token },
            { $set: {
                status: terminal ? AUDIT_OUTBOX_STATUS.FAILED : AUDIT_OUTBOX_STATUS.PENDING,
                lastError: String(error.message || error).slice(0, 1000),
                nextAttemptAt: terminal ? null : new Date(Date.now() + Math.min(60_000, claimed.attempts * 2_000)),
                leaseOwner: null,
                leaseToken: null,
                leaseUntil: null,
            } }
        );
        return { claimed: true, delivered: false, error };
    }
};

const processAuditOutboxBatch = async ({ limit = 100 } = {}) => {
    let delivered = 0;
    let failed = 0;
    for (let i = 0; i < limit; i += 1) {
        const result = await deliverOneAuditEvent();
        if (!result.claimed) break;
        if (result.delivered) delivered += 1;
        else failed += 1;
    }
    return { delivered, failed };
};

const startAuditOutboxWorker = ({ intervalMs = 2_000 } = {}) => {
    if (workerTimer) return;
    workerStopping = false;
    workerTimer = setInterval(async () => {
        if (workerStopping || workerRunning || mongoose.connection.readyState !== 1) return;
        workerRunning = true;
        try { await processAuditOutboxBatch(); }
        catch (error) { console.error('[AuditOutbox] worker failed:', error.message); }
        finally {
            workerRunning = false;
            if (workerIdleWaiters.length) workerIdleWaiters.splice(0).forEach((resolve) => resolve());
        }
    }, intervalMs);
    workerTimer.unref?.();
};

const stopAuditOutboxWorker = async ({ timeoutMs = 8_000 } = {}) => {
    workerStopping = true;
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    if (!workerRunning) return;
    await Promise.race([
        new Promise((resolve) => workerIdleWaiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
};

const listOutboxIssues = async ({ limit = 100 } = {}) => AuditOutbox.find({ status: { $in: [AUDIT_OUTBOX_STATUS.FAILED, AUDIT_OUTBOX_STATUS.PROCESSING, AUDIT_OUTBOX_STATUS.PENDING] } })
    .sort({ createdAt: 1 }).limit(Math.min(500, limit)).lean();

module.exports = {
    ensureAuditOutboxIndexesReady,
    makeAuditEvent,
    enqueueAuditEvents,
    deliverOneAuditEvent,
    processAuditOutboxBatch,
    startAuditOutboxWorker,
    stopAuditOutboxWorker,
    listOutboxIssues,
};
