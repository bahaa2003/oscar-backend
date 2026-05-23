'use strict';

const mongoose = require('mongoose');

/**
 * currency.model.js
 *
 * Two-layer currency architecture (mirrors ProviderProduct → Product):
 *
 *   External Exchange API  →  marketRate  (raw, market value)
 *                          →  platformRate (admin-controlled, used for billing)
 *
 * Only platformRate is ever used in financial calculations.
 * marketRate is stored for admin visibility / auto-sync reference.
 */

const currencySchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: [true, 'Currency code is required'],
            uppercase: true,
            trim: true,
            unique: true,
            match: [/^[A-Z]{3}$/, 'Currency code must be a 3-letter ISO 4217 code (e.g. USD, SAR)'],
        },

        name: {
            type: String,
            required: [true, 'Currency name is required'],
            trim: true,
            maxlength: [64, 'Currency name cannot exceed 64 characters'],
        },

        symbol: {
            type: String,
            required: [true, 'Currency symbol is required'],
            trim: true,
            maxlength: [8, 'Symbol cannot exceed 8 characters'],
        },

        /**
         * marketRate — the raw exchange rate returned by the external API.
         * Base currency is always USD (1 USD = marketRate units of this currency).
         * Updated automatically by the exchange rate sync service; never used
         * directly in financial math.
         */
        marketRate: {
            type: Number,
            default: null,
            min: [0, 'Market rate cannot be negative'],
        },

        /**
         * platformRate — the admin-controlled rate used for all conversions.
         * Can be set above / below marketRate to build in a spread.
         * USD always has platformRate = 1.
         */
        platformRate: {
            type: Number,
            required: [true, 'Platform rate is required'],
            min: [0.000001, 'Platform rate must be positive'],
        },

        /**
         * markupPercentage — optional admin-controlled markup layered ON TOP of
         * the raw market rate when computing a suggested platformRate.
         * Purely informational; the service layer applies it when auto-setting
         * platformRate from marketRate.
         * 0 = no markup.
         */
        markupPercentage: {
            type: Number,
            default: 0,
            min: [0, 'Markup percentage cannot be negative'],
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        lastUpdatedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// code: unique index declared inline (unique: true)
currencySchema.index({ isActive: 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

/**
 * Effective platform rate incorporating the markup percentage.
 * Used for display/audit only — services always read platformRate directly.
 */
currencySchema.virtual('effectiveRate').get(function () {
    if (!this.marketRate) return this.platformRate;
    return parseFloat(
        (this.marketRate * (1 + this.markupPercentage / 100)).toFixed(6)
    );
});

/**
 * Spread between platform rate and market rate, as a percentage.
 * Positive = platform charges more than market.
 */
currencySchema.virtual('spreadPercent').get(function () {
    if (!this.marketRate || this.marketRate === 0) return null;
    return parseFloat(
        (((this.platformRate - this.marketRate) / this.marketRate) * 100).toFixed(2)
    );
});

const Currency = mongoose.model('Currency', currencySchema);

module.exports = { Currency };
