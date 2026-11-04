'use strict';

const mongoose = require('mongoose');

const AUDIT_OUTBOX_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    DELIVERED: 'DELIVERED',
    FAILED: 'FAILED',
});

const auditOutboxSchema = new mongoose.Schema({
    eventId: { type: String, required: true, trim: true },
    eventType: { type: String, required: true, trim: true },
    status: { type: String, enum: Object.values(AUDIT_OUTBOX_STATUS), default: AUDIT_OUTBOX_STATUS.PENDING, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    attempts: { type: Number, min: 0, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, maxlength: 1000, default: null },
    createdAt: { type: Date, default: Date.now, immutable: true },
    deliveredAt: { type: Date, default: null },
}, { versionKey: false });

auditOutboxSchema.index({ eventId: 1 }, { unique: true });
auditOutboxSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 });

const AuditOutbox = mongoose.model('AuditOutbox', auditOutboxSchema);

module.exports = { AuditOutbox, AUDIT_OUTBOX_STATUS };
