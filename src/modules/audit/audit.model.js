'use strict';

const mongoose = require('mongoose');
const { ALL_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('./audit.constants');

/**
 * AuditLog schema.
 *
 * Design principles:
 *
 *   APPEND-ONLY
 *   - No `updatedAt` timestamp (timestamps: { createdAt: true, updatedAt: false })
 *   - versionKey: false — removes the __v field that Mongoose normally adds
 *   - No pre/post update hooks anywhere in this file
 *
 *   TAMPER-RESISTANCE
 *   - No schema-level update validators (there are none)
 *   - Service layer exposes no update/delete methods
 *   - metadata is frozen before save (see audit.service.js)
 *
 *   QUERYABILITY
 *   - Compound index on { entityType, entityId, createdAt } for entity timelines
 *   - Index on { actorId, createdAt } for actor history
 *   - Index on { action, createdAt } for action-type dashboards
 */
const auditLogSchema = new mongoose.Schema(
    {
        /**
         * Who performed the action.
         * For automated/system events use a well-known SYSTEM ObjectId
         * or pass a sentinel value — the service layer handles this.
         */
        actorId: {
            type: mongoose.Schema.Types.ObjectId,
            required: [true, 'actorId is required'],
            index: false, // covered by compound index below
        },

        /** Role of the actor at the time of the event. */
        actorRole: {
            type: String,
            required: [true, 'actorRole is required'],
            enum: {
                values: Object.values(ACTOR_ROLES),
                message: `actorRole must be one of: ${Object.values(ACTOR_ROLES).join(', ')}`,
            },
        },

        /**
         * Canonical action name from audit.constants.js.
         * Validated strictly — unknown strings are rejected at the DB layer.
         */
        action: {
            type: String,
            required: [true, 'action is required'],
            enum: {
                values: ALL_ACTIONS,
                message: `action must be one of the defined audit constants`,
            },
        },

        /**
         * The category of the entity that was acted upon.
         * entityType + entityId together form the audit timeline query.
         */
        entityType: {
            type: String,
            required: [true, 'entityType is required'],
            enum: {
                values: Object.values(ENTITY_TYPES),
                message: `entityType must be one of: ${Object.values(ENTITY_TYPES).join(', ')}`,
            },
        },

        /** ID of the specific entity (user._id, order._id, etc.). Optional for SYSTEM events. */
        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
        },

        /**
         * Structured JSON payload — arbitrary key/value data relevant to the event.
         *
         * Rules enforced in audit.service.js (not schema-level):
         *   - Passwords, tokens, secrets are stripped before save
         *   - Object is deeply frozen before persisting
         *   - Max serialised size is kept small by convention
         */
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        /** Originating IP address (from req.ip or req.auditContext). */
        ipAddress: {
            type: String,
            default: null,
            trim: true,
        },

        /** Browser / client user-agent string. */
        userAgent: {
            type: String,
            default: null,
            trim: true,
        },
    },
    {
        // Only record creation time — AuditLogs are never updated
        timestamps: { createdAt: true, updatedAt: false },
        versionKey: false,  // no __v field
        // Do NOT enable virtuals — keep document shape minimal
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Primary query: "show me the full timeline for entity X"
 * e.g. GET /api/audit/entity/ORDER/<id>
 */
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

/**
 * Secondary query: "show me everything actor Y has done"
 * e.g. GET /api/audit/actor/<adminId>
 */
auditLogSchema.index({ actorId: 1, createdAt: -1 });

/**
 * Tertiary query: "show me all events of action type X"
 * Useful for compliance dashboards (all WALLET_DEBIT events, etc.)
 */
auditLogSchema.index({ action: 1, createdAt: -1 });

// ─── Immutability Hook ────────────────────────────────────────────────────────

/**
 * Prevent any update operation from running against this collection.
 * These hooks fire if someone accidentally calls AuditLog.updateOne() etc.
 * They throw immediately, providing a clear stack trace.
 *
 * This is the defence-in-depth layer below the service-layer restriction.
 */
const IMMUTABILITY_ERROR =
    'AuditLog documents are immutable. Updates and deletes are not permitted.';

for (const hook of ['updateOne', 'findOneAndUpdate', 'updateMany']) {
    auditLogSchema.pre(hook, function () {
        throw new Error(IMMUTABILITY_ERROR);
    });
}

for (const hook of ['deleteOne', 'findOneAndDelete', 'deleteMany']) {
    auditLogSchema.pre(hook, function () {
        throw new Error(IMMUTABILITY_ERROR);
    });
}

// ─── Model ────────────────────────────────────────────────────────────────────

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = { AuditLog, IMMUTABILITY_ERROR };
