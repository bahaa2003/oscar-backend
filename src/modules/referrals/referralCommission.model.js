'use strict';

const mongoose = require('mongoose');

const COMMISSION_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    LOCKED: 'LOCKED',
    PAID: 'PAID',
    CANCELLED: 'CANCELLED',
});

const COMMISSION_CURRENCY = 'USD';
const COMMISSION_CALCULATION_VERSION = 'v1';
const COMMISSION_POLICY_SOURCE = 'ENV_REFERRAL_COMMISSION';

const decimalStringValidator = {
    validator(value) {
        return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
    },
    message: '{PATH} must be a decimal string',
};

const referralCommissionSchema = new mongoose.Schema(
    {
        referrerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'referrerId is required'],
            index: true,
            immutable: true,
        },
        referredUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'referredUserId is required'],
            index: true,
            immutable: true,
        },
        depositId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'DepositRequest',
            required: [true, 'depositId is required'],
            immutable: true,
        },
        walletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            required: [true, 'walletTransactionId is required'],
            immutable: true,
        },

        sourceAmount: {
            type: String,
            required: [true, 'sourceAmount is required'],
            validate: decimalStringValidator,
            immutable: true,
        },
        sourceCurrency: {
            type: String,
            required: [true, 'sourceCurrency is required'],
            uppercase: true,
            trim: true,
            match: [/^[A-Z]{3}$/, 'sourceCurrency must be a 3-letter ISO code'],
            immutable: true,
        },
        sourceExchangeRate: {
            type: String,
            required: [true, 'sourceExchangeRate is required'],
            validate: decimalStringValidator,
            immutable: true,
        },
        sourceAmountUsd: {
            type: String,
            required: [true, 'sourceAmountUsd is required'],
            validate: decimalStringValidator,
            immutable: true,
        },

        commissionRatePercent: {
            type: String,
            required: [true, 'commissionRatePercent is required'],
            validate: decimalStringValidator,
            immutable: true,
        },
        commissionAmountUsd: {
            type: String,
            required: [true, 'commissionAmountUsd is required'],
            validate: decimalStringValidator,
            immutable: true,
        },
        commissionCurrency: {
            type: String,
            enum: [COMMISSION_CURRENCY],
            default: COMMISSION_CURRENCY,
            immutable: true,
        },

        status: {
            type: String,
            enum: Object.values(COMMISSION_STATUS),
            default: COMMISSION_STATUS.AVAILABLE,
            index: true,
        },

        payoutRequestId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ReferralPayoutRequest',
            default: null,
            index: true,
        },

        availableAt: {
            type: Date,
            required: [true, 'availableAt is required'],
            immutable: true,
        },
        lockedAt: {
            type: Date,
            default: null,
        },
        paidAt: {
            type: Date,
            default: null,
        },
        cancelledAt: {
            type: Date,
            default: null,
        },

        referralSource: {
            type: String,
            default: null,
            immutable: true,
        },
        referredAt: {
            type: Date,
            required: [true, 'referredAt is required'],
            immutable: true,
        },
        calculationVersion: {
            type: String,
            enum: [COMMISSION_CALCULATION_VERSION],
            default: COMMISSION_CALCULATION_VERSION,
            immutable: true,
        },
        policySource: {
            type: String,
            enum: [COMMISSION_POLICY_SOURCE],
            default: COMMISSION_POLICY_SOURCE,
            immutable: true,
        },
        idempotencyKey: {
            type: String,
            required: [true, 'idempotencyKey is required'],
            trim: true,
            maxlength: 160,
            immutable: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

referralCommissionSchema.index(
    { depositId: 1 },
    { unique: true, name: 'unique_referral_commission_per_deposit' }
);
referralCommissionSchema.index(
    { idempotencyKey: 1 },
    { unique: true, name: 'unique_referral_commission_idempotency_key' }
);
referralCommissionSchema.index({ referrerId: 1, status: 1, createdAt: -1 });
referralCommissionSchema.index({ referredUserId: 1, createdAt: -1 });
referralCommissionSchema.index({ walletTransactionId: 1 });

const ReferralCommission = mongoose.model('ReferralCommission', referralCommissionSchema);

module.exports = {
    ReferralCommission,
    COMMISSION_STATUS,
    COMMISSION_CURRENCY,
    COMMISSION_CALCULATION_VERSION,
    COMMISSION_POLICY_SOURCE,
};
