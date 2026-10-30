'use strict';

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true, index: true },
    payerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: String, enum: ['THEME_PRO', 'THEME_ULTRA'], required: true },
    amountMinor: { type: Number, enum: [500, 2499, 2999], required: true },
    currency: { type: String, enum: ['USD', 'USDT'], required: true },
    status: { type: String, enum: ['ACTIVE', 'EXPIRED', 'REVOKED'], required: true },
    durationCalendarMonths: { type: Number, enum: [3, 10], default: 3 },
    verifiedPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformThemePayment', required: true, unique: true },
    upgradedFromSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformThemeSubscription', default: null },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });
subscriptionSchema.index({ scopeKey: 1, expiresAt: -1 });

const paymentSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true, index: true },
    payerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, required: true },
    providerReference: { type: String, required: true },
    planId: { type: String, enum: ['THEME_PRO', 'THEME_ULTRA'], default: 'THEME_PRO' },
    isUpgrade: { type: Boolean, default: false },
    upgradedFromSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformThemeSubscription', default: null },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'VERIFIED', 'FAILED', 'CANCELLED', 'REFUNDED', 'CHARGEBACK'], required: true },
    durationCalendarMonths: { type: Number, enum: [3, 10], default: 3 },
    verifiedAt: { type: Date, default: null },
    settlementCurrency: { type: String, enum: ['USDT'], default: undefined },
    settlementAmount: { type: String, default: undefined },
    network: { type: String, enum: ['BINANCE_ID', 'TRC20', 'BEP20'], default: undefined },
    destination: { type: String, default: undefined },
    chainTransactionId: { type: String, default: undefined },
    verifiedBy: { type: String, default: undefined },
    activationDeliveryStatus: { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'], default: undefined },
    activationDeliveryAt: { type: Date, default: null },
    activationDeliveryError: { type: String, default: undefined },
}, { timestamps: true });
paymentSchema.index({ provider: 1, providerReference: 1 }, { unique: true });
paymentSchema.index({ provider: 1, chainTransactionId: 1 }, { unique: true,
    partialFilterExpression: { chainTransactionId: { $type: 'string' } } });

const activationCodeSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformThemePayment', required: true, unique: true },
    payerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    salt: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    redeemedAt: { type: Date, default: null },
    issuedBy: { type: String, required: true },
    issueCount: { type: Number, default: 1, min: 1 },
}, { timestamps: true });

// Keep a permanent record of issued codes so a preselected code cannot be
// assigned to a second transfer, including after the first code expires.
const codeUseSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformThemePayment', required: true },
    codeFingerprint: { type: String, required: true, unique: true },
    issuedAt: { type: Date, required: true },
}, { timestamps: true });

module.exports = {
    ThemeSubscription: mongoose.model('PlatformThemeSubscription', subscriptionSchema),
    ThemePayment: mongoose.model('PlatformThemePayment', paymentSchema),
    ThemeActivationCode: mongoose.model('PlatformThemeActivationCode', activationCodeSchema),
    ThemeCodeUse: mongoose.model('PlatformThemeCodeUse', codeUseSchema),
};
