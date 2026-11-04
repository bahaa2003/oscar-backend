'use strict';

const mongoose = require('mongoose');

const DEPOSIT_CREDIT_GUARD_STATUS = Object.freeze({
    PREPARED: 'PREPARED',
    APPLIED: 'APPLIED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const depositCreditGuardSchema = new mongoose.Schema({
    idempotencyKey: { type: String, required: true, trim: true },
    depositId: { type: mongoose.Schema.Types.ObjectId, ref: 'DepositRequest', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: {
        type: String,
        enum: Object.values(DEPOSIT_CREDIT_GUARD_STATUS),
        required: true,
        default: DEPOSIT_CREDIT_GUARD_STATUS.PREPARED,
    },
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now, immutable: true },
    completedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1000 },
    leaseOwner: { type: String, default: null },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
}, { versionKey: false });

depositCreditGuardSchema.index({ idempotencyKey: 1 }, { unique: true });
depositCreditGuardSchema.index({ depositId: 1 }, { unique: true });
depositCreditGuardSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });

const DepositCreditGuard = mongoose.model('DepositCreditGuard', depositCreditGuardSchema);

module.exports = { DepositCreditGuard, DEPOSIT_CREDIT_GUARD_STATUS };
