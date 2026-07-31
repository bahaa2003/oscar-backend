'use strict';

const mongoose = require('mongoose');

const RESELLER_APPLICATION_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    SUSPENDED: 'SUSPENDED',
});

const BUSINESS_TYPES = Object.freeze({
    INDIVIDUAL: 'INDIVIDUAL',
    STORE: 'STORE',
    AGENCY: 'AGENCY',
    OTHER: 'OTHER',
});

const SALES_CHANNELS = Object.freeze({
    ONLINE: 'ONLINE',
    OFFLINE: 'OFFLINE',
    SOCIAL: 'SOCIAL',
    MARKETPLACE: 'MARKETPLACE',
    OTHER: 'OTHER',
});

const CONTACT_METHODS = Object.freeze({
    PHONE: 'PHONE',
    WHATSAPP: 'WHATSAPP',
    EMAIL: 'EMAIL',
});

const nonNegativeDecimalStringValidator = {
    validator(value) {
        return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value);
    },
    message: '{PATH} must be a non-negative decimal string',
};

const resellerApplicationSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },
        applicationNumber: {
            type: String,
            required: [true, 'applicationNumber is required'],
            trim: true,
            uppercase: true,
            maxlength: 40,
            immutable: true,
        },
        status: {
            type: String,
            enum: Object.values(RESELLER_APPLICATION_STATUS),
            default: RESELLER_APPLICATION_STATUS.PENDING,
            index: true,
        },
        businessName: {
            type: String,
            required: [true, 'businessName is required'],
            trim: true,
            minlength: 2,
            maxlength: 120,
        },
        businessType: {
            type: String,
            enum: Object.values(BUSINESS_TYPES),
            default: BUSINESS_TYPES.INDIVIDUAL,
        },
        country: {
            type: String,
            required: [true, 'country is required'],
            trim: true,
            minlength: 2,
            maxlength: 80,
        },
        city: {
            type: String,
            required: [true, 'city is required'],
            trim: true,
            minlength: 2,
            maxlength: 80,
        },
        expectedMonthlyVolume: {
            type: String,
            required: [true, 'expectedMonthlyVolume is required'],
            validate: nonNegativeDecimalStringValidator,
        },
        experienceSummary: {
            type: String,
            required: [true, 'experienceSummary is required'],
            trim: true,
            minlength: 10,
            maxlength: 2000,
        },
        salesChannels: [{
            type: String,
            enum: Object.values(SALES_CHANNELS),
        }],
        targetMarkets: [{
            type: String,
            trim: true,
            maxlength: 80,
        }],
        websiteUrl: {
            type: String,
            trim: true,
            maxlength: 300,
            default: null,
        },
        socialProfileUrl: {
            type: String,
            trim: true,
            maxlength: 300,
            default: null,
        },
        contactPhone: {
            type: String,
            required: [true, 'contactPhone is required'],
            trim: true,
            minlength: 6,
            maxlength: 40,
        },
        preferredContactMethod: {
            type: String,
            enum: Object.values(CONTACT_METHODS),
            default: CONTACT_METHODS.WHATSAPP,
        },
        requestedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },
        assignedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },
        previousGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },
        submittedAt: {
            type: Date,
            required: true,
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
        approvedAt: {
            type: Date,
            default: null,
        },
        rejectedAt: {
            type: Date,
            default: null,
        },
        rejectionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        suspendedAt: {
            type: Date,
            default: null,
        },
        suspensionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        reactivatedAt: {
            type: Date,
            default: null,
        },
        applicationSnapshot: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        idempotencyKey: {
            type: String,
            required: [true, 'idempotencyKey is required'],
            trim: true,
            maxlength: 180,
            immutable: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

resellerApplicationSchema.index(
    { applicationNumber: 1 },
    { unique: true, name: 'unique_reseller_application_number' }
);
resellerApplicationSchema.index(
    { idempotencyKey: 1 },
    { unique: true, name: 'unique_reseller_application_idempotency_key' }
);
resellerApplicationSchema.index(
    { userId: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: RESELLER_APPLICATION_STATUS.PENDING },
        name: 'unique_pending_reseller_application_per_user',
    }
);
resellerApplicationSchema.index({ status: 1, submittedAt: -1 });
resellerApplicationSchema.index({ assignedGroupId: 1, status: 1 });

const ResellerApplication = mongoose.model('ResellerApplication', resellerApplicationSchema);

module.exports = {
    ResellerApplication,
    RESELLER_APPLICATION_STATUS,
    BUSINESS_TYPES,
    SALES_CHANNELS,
    CONTACT_METHODS,
};
