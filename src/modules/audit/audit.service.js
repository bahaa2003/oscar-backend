'use strict';

const { AuditLog } = require('./audit.model');
const { ALL_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('./audit.constants');

// ─── Sensitive key stripping ──────────────────────────────────────────────────

/** Keys whose values must NEVER appear in an audit log metadata payload. */
const REDACTED_KEYS = new Set([
    'password', 'passwordhash', 'hashedpassword',
    'token', 'accesstoken', 'refreshtoken', 'jwt',
    'secret', 'apikey', 'privatekey', 'creditcard',
    'cvv', 'ssn',
]);

/**
 * Recursively strip sensitive keys from an object and return a plain,
 * JSON-serialisable copy.  Circular references are silently dropped.
 *
 * @param {*}   value  - any JSON-serialisable value
 * @param {Set} [seen] - cycle detector
 * @returns {*}
 */
const sanitize = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((v) => sanitize(v, seen));
    }

    const result = {};
    for (const [k, v] of Object.entries(value)) {
        if (REDACTED_KEYS.has(k.toLowerCase())) {
            result[k] = '[REDACTED]';
        } else {
            result[k] = sanitize(v, seen);
        }
    }
    return result;
};

/**
 * Deep-freeze an object so the metadata stored on the Mongoose Mixed field
 * cannot be mutated after being attached to the document.
 *
 * NOTE: Mongoose Mixed fields are stored by reference — without freezing, a
 * caller could modify the object after calling createAuditLog and before
 * the Promise resolves.
 *
 * @param {*} obj
 * @returns {*} the same reference, now frozen
 */
const deepFreeze = (obj) => {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach((k) => deepFreeze(obj[k]));
    return Object.freeze(obj);
};

// ─── Internal write helper ────────────────────────────────────────────────────

/**
 * Write one AuditLog document.
 * Validates the action string before hitting the DB so the error message
 * is actionable (not a Mongoose enum validation stack trace).
 *
 * @private
 */
const _write = async ({
    actorId,
    actorRole,
    action,
    entityType,
    entityId = null,
    metadata = null,
    ipAddress = null,
    userAgent = null,
}) => {
    // Guard: unknown action strings are programming errors, not runtime errors.
    if (!ALL_ACTIONS.includes(action)) {
        throw new Error(`[Audit] Unknown action constant: '${action}'`);
    }

    if (!Object.values(ENTITY_TYPES).includes(entityType)) {
        throw new Error(`[Audit] Unknown entityType: '${entityType}'`);
    }

    const safeMetadata = metadata !== null
        ? deepFreeze(sanitize(metadata))
        : null;

    await AuditLog.create({
        actorId,
        actorRole,
        action,
        entityType,
        entityId,
        metadata: safeMetadata,
        ipAddress,
        userAgent,
    });
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * createAuditLog — fire-and-forget wrapper around _write.
 *
 * Transaction Safety Contract:
 * ─────────────────────────────
 * This function MUST be called AFTER a financial transaction has committed.
 * It always writes to the default (non-transactional) connection — audit logs
 * intentionally live outside the financial transaction boundary.
 *
 * Why:
 *   • If the audit write is inside the session and the session aborts, the log
 *     is lost — which is preferable to rolling back a committed payment.
 *   • If the audit write is outside the session and FAILS, the financial state
 *     is still consistent — the log is just missing, which is far less harmful
 *     than an unintended rollback.
 *   • We capture and log errors internally rather than re-throwing, so callers
 *     never see audit failures.
 *
 * Fire-and-forget:
 *   The returned Promise always resolves. Errors are written to stderr.
 *   This means callers must NOT await this function if they want non-blocking
 *   behaviour. If the caller does await it, the Promise still resolves (never rejects).
 *
 * @param {Object} params - same shape as _write
 * @returns {Promise<void>} always resolves
 */
const createAuditLog = async (params) => {
    try {
        await _write(params);
    } catch (err) {
        // Never propagate — this must never break a caller's flow.
        // 'client was closed' errors happen when fire-and-forget Promises resolve
        // after the test suite has torn down the DB connection — safe to ignore.
        const msg = err.message || '';
        if (!msg.includes('client was closed') && !msg.includes('connection was destroyed')) {
            console.error('[AuditLog] Failed to write audit entry:', msg, {
                action: params.action,
                entityType: params.entityType,
                entityId: params.entityId?.toString?.(),
            });
        }
    }
};

/**
 * getEntityAuditLogs — paginated timeline for a specific entity.
 *
 * Hits the compound index { entityType, entityId, createdAt }.
 *
 * @param {string}    entityType
 * @param {ObjectId|string} entityId
 * @param {Object}    [opts]
 * @param {number}    [opts.page=1]
 * @param {number}    [opts.limit=20]
 *
 * @returns {{ logs: AuditLog[], pagination: Object }}
 */
const getEntityAuditLogs = async (entityType, entityId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
        AuditLog.find({ entityType, entityId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),   // read-only projection — lean() returns plain JS objects
        AuditLog.countDocuments({ entityType, entityId }),
    ]);

    return {
        logs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * getActorAuditLogs — paginated history of everything an actor has done.
 *
 * Hits the index { actorId, createdAt }.
 *
 * @param {ObjectId|string} actorId
 * @param {Object}          [opts]
 * @param {number}          [opts.page=1]
 * @param {number}          [opts.limit=20]
 *
 * @returns {{ logs: AuditLog[], pagination: Object }}
 */
const getActorAuditLogs = async (actorId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
        AuditLog.find({ actorId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AuditLog.countDocuments({ actorId }),
    ]);

    return {
        logs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

module.exports = {
    createAuditLog,
    getEntityAuditLogs,
    getActorAuditLogs,
    // Expose for testing only — not part of the public service API
    _sanitize: sanitize,
};
