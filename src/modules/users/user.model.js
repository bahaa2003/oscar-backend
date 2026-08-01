'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../../config/config');
const {
    generateReferralCodeCandidate,
    normalizeReferralCode,
} = require('../referrals/referralCode.generator');

/**
 * User roles enum — single source of truth.
 */
const ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    SUPERVISOR: 'SUPERVISOR',
    CUSTOMER: 'CUSTOMER',
});

/**
 * User status lifecycle enum.
 *
 * PENDING  → registered, awaiting admin approval (default for new registrations)
 * ACTIVE   → approved by admin; full platform access
 * REJECTED → denied by admin; cannot log in
 *
 * Transitions allowed:
 *   PENDING  → ACTIVE    (admin approval)
 *   PENDING  → REJECTED  (admin rejection)
 *   ACTIVE   → REJECTED  (admin revoke)
 *   REJECTED → ACTIVE    (admin re-approve)
 */
const USER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    REJECTED: 'REJECTED',
});

const RESELLER_STATUS = Object.freeze({
    NONE: 'NONE',
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    SUSPENDED: 'SUSPENDED',
});

const REFERRAL_SOURCE = Object.freeze({
    EMAIL_REGISTRATION: 'EMAIL_REGISTRATION',
    GOOGLE_OAUTH: 'GOOGLE_OAUTH',
});

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
            minlength: [2, 'Name must be at least 2 characters'],
            maxlength: [100, 'Name cannot exceed 100 characters'],
        },

        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
        },

        password: {
            type: String,
            // Not required for OAuth users (Google sign-in never sets a password)
            minlength: [8, 'Password must be at least 8 characters'],
            select: false, // Never return password in queries by default
        },

        // ── OAuth ────────────────────────────────────────────────────────────
        /**
         * Google OAuth sub (subject identifier).
         * Null for email/password accounts.
         * Used by the Google passport strategy to find/link accounts.
         */
        googleId: {
            type: String,
            unique: true,
            sparse: true,   // only indexes documents where googleId is set
            // NOTE: no default — absent field is what sparse indexes expect
        },

        // ── Email Verification ────────────────────────────────────────────────
        /**
         * true  — user has clicked the verification link
         * false — fresh email/password registration (default)
         * Google OAuth users are auto-verified (set to true at creation).
         */
        verified: {
            type: Boolean,
            default: false,
        },

        /**
         * SHA-256 hash of the raw token sent in the verification email.
         * Raw token is NEVER stored here — only the hash.
         * Null once verified.
         */
        emailVerificationToken: {
            type: String,
            select: false,
            default: null,
        },

        /** Token expires 24 hours after issuance. */
        emailVerificationExpires: {
            type: Date,
            select: false,
            default: null,
        },

        role: {
            type: String,
            enum: Object.values(ROLES),
            default: ROLES.CUSTOMER,
        },

        // ── Activation Lifecycle ─────────────────────────────────────────────
        /**
         * status governs platform access.
         * New registrations default to PENDING — admin must approve before the
         * user can log in, place orders, or use their wallet.
         *
         * Backwards-compatibility: the `isActive` virtual below delegates to
         * this field so any code that already reads `user.isActive` continues
         * to work without modification.
         */
        status: {
            type: String,
            enum: {
                values: Object.values(USER_STATUS),
                message: 'status must be PENDING, ACTIVE, or REJECTED',
            },
            default: USER_STATUS.PENDING,
            index: true,
        },

        /** Admin who approved the account (null until approved). */
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        approvedAt: {
            type: Date,
            default: null,
        },

        /** Admin who rejected the account (null until rejected). */
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        rejectedAt: {
            type: Date,
            default: null,
        },

        // ── Pricing Group ────────────────────────────────────────────────────
        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            required: [true, 'A user must belong to a pricing group'],
            default: null,
        },

        referralCode: {
            type: String,
            required: [true, 'Referral code is required'],
            trim: true,
            uppercase: true,
            minlength: [8, 'Referral code must be at least 8 characters'],
            maxlength: [12, 'Referral code cannot exceed 12 characters'],
            match: [/^[A-Z2-9]+$/, 'Referral code must be uppercase and URL-safe'],
            default: () => generateReferralCodeCandidate(),
            set: normalizeReferralCode,
        },

        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            select: false,
        },

        referredAt: {
            type: Date,
            default: null,
            select: false,
        },

        referralSource: {
            type: String,
            enum: Object.values(REFERRAL_SOURCE),
            default: null,
            select: false,
        },

        resellerStatus: {
            type: String,
            enum: Object.values(RESELLER_STATUS),
            default: RESELLER_STATUS.NONE,
            index: true,
        },

        resellerApprovedAt: {
            type: Date,
            default: null,
        },

        resellerApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            select: false,
        },

        resellerRejectedAt: {
            type: Date,
            default: null,
        },

        resellerRejectionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },

        resellerSuspendedAt: {
            type: Date,
            default: null,
        },

        resellerSuspensionReason: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },

        resellerReactivatedAt: {
            type: Date,
            default: null,
        },

        resellerGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
            index: true,
        },

        referrerCommissionStoppedAt: {
            type: Date,
            default: null,
            select: false,
        },

        // ── Dynamic RBAC Permissions ─────────────────────────────────────────
        /**
         * Fine-grained permissions for SUPERVISOR (or any) role.
         * Admins bypass permission checks entirely.
         * Example: ['MANAGE_DEPOSITS', 'VIEW_ORDERS']
         */
        permissions: {
            type: [String],
            default: [],
        },

        // ── Two-Factor Authentication ────────────────────────────────────────
        /**
         * Hashed email OTP for pending 2FA login challenges.
         * Raw OTP codes are never stored.
         */
        twoFactorOtp: {
            type: String,
            select: false,
            default: null,
        },

        /** Expiration timestamp for the pending 2FA email OTP. */
        twoFactorOtpExpires: {
            type: Date,
            select: false,
            default: null,
        },

        /** Whether the user must complete email OTP verification to log in. */
        isTwoFactorEnabled: {
            type: Boolean,
            default: false,
        },

        // ── Wallet ───────────────────────────────────────────────────────────
        /**
         * User's wallet balance in their local currency.
         * CAN be negative when a user spends against their creditLimit.
         * Minimum effective balance = -(creditLimit).
         */
        walletBalance: {
            type: Number,
            default: 0,
        },

        creditLimit: {
            type: Number,
            default: 0,
            min: [0, 'Credit limit cannot be negative'],
        },

        /**
         * creditUsed: the amount of the credit line currently drawn.
         *
         * Real spendable formula:
         *   available = walletBalance + (creditLimit - creditUsed)
         *
         * On order creation:
         *   - wallet is used first
         *   - remaining goes against credit → creditUsed increases
         *
         * On refund:
         *   - creditUsed decreases first (credit is "returned")
         *   - then walletBalance is restored
         */
        creditUsed: {
            type: Number,
            default: 0,
            min: [0, 'Credit used cannot be negative'],
        },

        // ── Quantity-Only Billing ─────────────────────────────────────────────
        /**
         * Maximum cumulative quantity this user can order under quantity_only billing.
         * Only meaningful when user.group.billingMode === 'quantity_only'.
         * Managed by admin. Does NOT affect wallet/credit logic.
         */
        quantityLimit: {
            type: Number,
            default: 0,
            min: [0, 'Quantity limit cannot be negative'],
        },

        /**
         * Cumulative quantity consumed so far under quantity_only billing.
         * Incremented atomically on each order. Reset by admin after offline settlement.
         */
        quantityUsed: {
            type: Number,
            default: 0,
            min: [0, 'Quantity used cannot be negative'],
        },

        // ── Currency ──────────────────────────────────────────────────────────
        /**
         * The ISO 4217 currency code for this user's wallet.
         * Wallet balances, order charges, and refunds are all denominated in this currency.
         * Products are priced in USD internally; the currency converter applies
         * the platform exchange rate at order creation time.
         *
         * Default: "USD" — no conversion needed.
         */
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'USD',
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (e.g. USD, SAR)'],
        },

        country: {
            type: String,
            uppercase: true,
            trim: true,
            default: null,
            match: [/^[A-Z]{2}$/, 'country must be a 2-letter ISO country code (e.g. EG, SA)'],
        },

        // ── Avatar ───────────────────────────────────────────────────────────
        /**
         * URL to the user's profile picture.
         * Can be an absolute URL (external host) or a relative path (local uploads).
         */
        avatar: {
            type: String,
            trim: true,
            default: null,
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: {
            virtuals: true,
            transform: (_doc, ret) => {
                delete ret.password;
                delete ret.emailVerificationToken;
                delete ret.emailVerificationExpires;
                delete ret.twoFactorOtp;
                delete ret.twoFactorOtpExpires;
                delete ret.referredBy;
                delete ret.referredAt;
                delete ret.referralSource;
                delete ret.resellerApprovedBy;
                delete ret.referrerCommissionStoppedAt;
                return ret;
            },
        },
        toObject: { virtuals: true },
    }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// Note: email already has a unique index from unique:true in the field definition
userSchema.index({ role: 1 });
userSchema.index({ groupId: 1 });
userSchema.index({ deletedAt: 1 }, { sparse: true });  // fast filter for non-deleted users
userSchema.index({ referredBy: 1, referredAt: -1 });
userSchema.index(
    { referralCode: 1 },
    {
        unique: true,
        partialFilterExpression: { referralCode: { $type: 'string', $gt: '' } },
        name: 'unique_referral_code',
    }
);
// status index defined inline above

// ─── Virtuals ────────────────────────────────────────────────────────────────

/**
 * Backwards-compatibility shim.
 * Any code that reads `user.isActive` continues to work correctly.
 * Source of truth is now `status`.
 */
userSchema.virtual('isActive').get(function () {
    return this.status === USER_STATUS.ACTIVE;
});

/**
 * Total spendable amount = wallet balance + credit limit.
 * This is the maximum amount the user can spend in a single order.
 * walletBalance may be negative (up to -creditLimit) after credit usage.
 */
userSchema.virtual('availableBalance').get(function () {
    const balance = this.walletBalance || 0;
    const credit = this.creditLimit || 0;
    return parseFloat((balance + credit).toFixed(2));
});

/** How much credit remains available (undrawn). */
userSchema.virtual('availableCredit').get(function () {
    return parseFloat((this.creditLimit - this.creditUsed).toFixed(2));
});

/** Remaining quantity quota for quantity_only billing. */
userSchema.virtual('quantityRemaining').get(function () {
    return Math.max(0, (this.quantityLimit || 0) - (this.quantityUsed || 0));
});

// ─── Pre-save Hook: Hash Password ────────────────────────────────────────────
userSchema.pre('save', async function (next) {
    // Skip if no password set (OAuth users) or password not modified
    if (!this.password || !this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, config.bcrypt.rounds);
    next();
});

userSchema.pre('save', async function (next) {
    if (this.isNew) return next();

    const protectedOnceSetFields = ['referredBy', 'referredAt', 'referralSource'];
    const protectedAlwaysFields = ['referralCode'];
    const modifiedProtected = [...protectedAlwaysFields, ...protectedOnceSetFields]
        .filter((field) => this.isModified(field));

    if (modifiedProtected.length === 0) return next();

    try {
        const previous = await this.constructor
            .findById(this._id)
            .select('+referredBy +referredAt +referralSource referralCode')
            .lean();

        if (!previous) return next();

        if (this.isModified('referralCode') && previous.referralCode !== this.referralCode) {
            return next(new Error('referralCode cannot be changed once assigned.'));
        }

        for (const field of protectedOnceSetFields) {
            if (!this.isModified(field)) continue;
            const oldValue = previous[field];
            if (oldValue != null && String(oldValue) !== String(this[field])) {
                return next(new Error(`${field} cannot be changed once assigned.`));
            }
        }

        return next();
    } catch (err) {
        return next(err);
    }
});

// ─── Instance Methods ─────────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Strip sensitive fields when serializing.
 */
userSchema.methods.toSafeObject = function () {
    const obj = this.toObject();
    delete obj.password;
    delete obj.emailVerificationToken;
    delete obj.emailVerificationExpires;
    delete obj.twoFactorOtp;
    delete obj.twoFactorOtpExpires;
    delete obj.referredBy;
    delete obj.referredAt;
    delete obj.referralSource;
    delete obj.resellerApprovedBy;
    delete obj.referrerCommissionStoppedAt;
    return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = { User, ROLES, USER_STATUS, RESELLER_STATUS, REFERRAL_SOURCE };
module.exports.User = User; // CommonJS default export convenience
