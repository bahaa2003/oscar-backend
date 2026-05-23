'use strict';

const mongoose = require('mongoose');

/**
 * Group model — defines a pricing tier for customers.
 *
 * `percentage` is the markup applied on top of base product price when
 * calculating the effective price for members of this group.
 * It is stored as a number (e.g. 15 means 15 %).
 *
 * The field with the highest percentage is automatically assigned to new
 * registrations (see auth.service.js → register).
 */
const groupSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Group name is required'],
            unique: true,
            trim: true,
            minlength: [2, 'Group name must be at least 2 characters'],
            maxlength: [100, 'Group name cannot exceed 100 characters'],
        },

        /**
         * Markup percentage for this pricing group.
         * Required — a group without a defined percentage is meaningless.
         * No upper bound enforced at the DB level (business may need > 100 %).
         */
        percentage: {
            type: Number,
            required: [true, 'Percentage is required'],
            min: [0, 'Percentage cannot be negative'],
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        /**
         * Billing mode for this group.
         *
         * 'standard'      — default wallet + credit billing (existing flow)
         * 'quantity_only'  — cumulative quantity quota; no pricing shown,
         *                    wallet/credit bypass, offline settlement
         */
        billingMode: {
            type: String,
            enum: ['standard', 'quantity_only'],
            default: 'standard',
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// unique:true on name already creates that index — no explicit .index() needed
groupSchema.index({ percentage: -1 }); // supports "highest percentage" queries

const Group = mongoose.model('Group', groupSchema);

module.exports = Group;
