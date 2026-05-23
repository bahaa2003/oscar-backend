'use strict';

const mongoose = require('mongoose');

/**
 * category.model.js
 *
 * Categories for product grouping and display.
 * Used by the admin dashboard to organize products and by the
 * customer-facing storefront for filtering / navigation.
 */

const categorySchema = new mongoose.Schema(
    {
        /** Display name (English). */
        name: {
            type: String,
            required: [true, 'Category name is required'],
            trim: true,
            minlength: [1, 'Category name must be at least 1 character'],
            maxlength: [100, 'Category name cannot exceed 100 characters'],
        },

        /** Display name (Arabic). */
        nameAr: {
            type: String,
            trim: true,
            default: null,
            maxlength: [100, 'Arabic name cannot exceed 100 characters'],
        },

        /** Public image URL for the category card. */
        image: {
            type: String,
            trim: true,
            default: null,
        },

        /** URL-safe slug auto-generated from name. */
        slug: {
            type: String,
            trim: true,
            lowercase: true,
            unique: true,
            sparse: true,
        },

        /** Lower numbers appear first in listings. */
        sortOrder: {
            type: Number,
            default: 0,
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        /**
         * Self-referencing parent for sub-category hierarchy.
         * null = top-level / root category.
         */
        parentCategory: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
            default: null,
            index: true,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
categorySchema.index({ isActive: 1, sortOrder: 1 });
categorySchema.index({ slug: 1 });
categorySchema.index({ parentCategory: 1, isActive: 1, sortOrder: 1 });

// ─── Pre-save: auto-generate slug from name ───────────────────────────────────
categorySchema.pre('save', function (next) {
    if (this.isModified('name') && !this.slug) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')  // keep Arabic chars + alphanum
            .replace(/^-+|-+$/g, '');                    // trim leading/trailing hyphens
    }
    next();
});

const Category = mongoose.model('Category', categorySchema);

module.exports = { Category };
