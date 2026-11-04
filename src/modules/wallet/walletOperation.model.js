'use strict';

const mongoose = require('mongoose');

const WALLET_OPERATION_STATUS = Object.freeze({
    PREPARED: 'PREPARED',
    APPLIED: 'APPLIED',
    LEDGER_RECORDED: 'LEDGER_RECORDED',
    OUTBOX_RECORDED: 'OUTBOX_RECORDED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const walletOperationSchema = new mongoose.Schema({
    idempotencyKey: { type: String, required: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    operationType: { type: String, required: true, trim: true },
    transactionType: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    delta: { type: Number, required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    reference: { type: mongoose.Schema.Types.ObjectId, default: null },
    description: { type: String, maxlength: 255, default: '' },
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },
    creditUsedAfter: { type: Number, default: null },
    creditUsedMode: { type: String, default: null },
    creditUsedAmount: { type: Number, default: null },
    expectedBalance: { type: Number, default: null },
    targetBalance: { type: Number, default: null },
    targetCurrency: { type: String, default: null, uppercase: true, trim: true },
    ledgerRequired: { type: Boolean, default: true },
    enforceAvailable: { type: Boolean, default: false },
    requireActiveUser: { type: Boolean, default: false },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: null },
    eventType: { type: String, default: null },
    auditAction: { type: String, default: null },
    auditMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    auditEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    status: { type: String, enum: Object.values(WALLET_OPERATION_STATUS), default: WALLET_OPERATION_STATUS.PREPARED, required: true },
    attempts: { type: Number, min: 0, default: 0 },
    repairSequence: { type: Number, min: 0, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    lastError: { type: String, maxlength: 1000, default: null },
    failureCode: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, immutable: true },
    completedAt: { type: Date, default: null },
}, { versionKey: false });

walletOperationSchema.index({ idempotencyKey: 1 }, { unique: true });
walletOperationSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
walletOperationSchema.index({ userId: 1, createdAt: -1 });

const WalletOperation = mongoose.model('WalletOperation', walletOperationSchema);

module.exports = { WalletOperation, WALLET_OPERATION_STATUS };
