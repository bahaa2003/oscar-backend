'use strict';

const mongoose = require('mongoose');

const PAYOUT_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PAID: 'PAID',
    REJECTED: 'REJECTED',
});

const PAYOUT_METHOD = Object.freeze({
    WALLET: 'WALLET',
    MANUAL: 'MANUAL',
});

const PAYOUT_CURRENCY = 'USD';

const decimalStringValidator = {
    validator(value) {
        return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value);
    },
    message: '{PATH} must be a non-negative decimal string',
};

const referralPayoutRequestSchema = new mongoose.Schema(
    {
        referrerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'referrerId is required'],
            index: true,
        },
        commissionIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ReferralCommission',
            required: true,
        }],
        amountUsd: {
            type: String,
            required: [true, 'amountUsd is required'],
            validate: decimalStringValidator,
        },
        amount: {
            type: String,
            default: null,
            validate: {
                validator(value) {
                    return value == null || decimalStringValidator.validator(value);
                },
                message: '{PATH} must be a non-negative decimal string',
            },
        },
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code'],
            default: PAYOUT_CURRENCY,
        },
        method: {
            type: String,
            enum: Object.values(PAYOUT_METHOD),
            required: [true, 'method is required'],
            index: true,
        },
        status: {
            type: String,
            enum: Object.values(PAYOUT_STATUS),
            default: PAYOUT_STATUS.PENDING,
            index: true,
        },
        idempotencyKey: {
            type: String,
            required: [true, 'idempotencyKey is required'],
            trim: true,
            maxlength: 180,
            immutable: true,
        },
        requestedAt: {
            type: Date,
            required: [true, 'requestedAt is required'],
            default: Date.now,
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        paidAt: {
            type: Date,
            default: null,
        },
        rejectedAt: {
            type: Date,
            default: null,
        },
        walletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            default: null,
        },
        externalReference: {
            type: String,
            trim: true,
            maxlength: 120,
            default: null,
        },
        manualSettlementNote: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        rejectionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        requestSnapshot: {
            commissionCount: {
                type: Number,
                required: true,
                min: 1,
            },
            amountUsd: {
                type: String,
                required: true,
                validate: decimalStringValidator,
            },
            amount: {
                type: String,
                default: null,
                validate: {
                    validator(value) {
                        return value == null || decimalStringValidator.validator(value);
                    },
                    message: '{PATH} must be a non-negative decimal string',
                },
            },
            currency: {
                type: String,
                uppercase: true,
                trim: true,
                match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code'],
                default: PAYOUT_CURRENCY,
            },
            commissionIds: [{
                type: mongoose.Schema.Types.ObjectId,
                ref: 'ReferralCommission',
            }],
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

referralPayoutRequestSchema.index(
    { idempotencyKey: 1 },
    { unique: true, name: 'unique_referral_payout_idempotency_key' }
);
referralPayoutRequestSchema.index({ referrerId: 1, status: 1, requestedAt: -1 });
referralPayoutRequestSchema.index({ status: 1, method: 1, requestedAt: -1 });

const ReferralPayoutRequest = mongoose.model('ReferralPayoutRequest', referralPayoutRequestSchema);

module.exports = {
    ReferralPayoutRequest,
    PAYOUT_STATUS,
    PAYOUT_METHOD,
    PAYOUT_CURRENCY,
};
