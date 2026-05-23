'use strict';

const mongoose = require('mongoose');

/**
 * ProviderProduct — INTERNAL ONLY.
 *
 * Raw product data as fetched (and refreshed) from a provider's API.
 * This collection is NEVER exposed to end-users.
 * Admins read it when deciding which products to publish.
 *
 * Lifecycle:
 *   Sync engine → upsert → ProviderProduct
 *   Admin → select ProviderProduct → create/link Product
 *
 * Immutability contract:
 *   rawPayload is replaced wholesale on each sync.
 *   All other raw* fields are also overwritten.
 *   The only field preserved across syncs is _id (the stable internal key).
 */
const providerProductSchema = new mongoose.Schema(
    {
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            required: [true, 'provider is required'],
            index: true,
        },

        /**
         * The product's identifier as returned by the provider's API.
         * Combined with `provider`, forms the natural key of this record.
         */
        externalProductId: {
            type: String,
            required: [true, 'externalProductId is required'],
            trim: true,
        },

        rawName: {
            type: String,
            required: [true, 'rawName is required'],
            trim: true,
        },

        /**
         * Optional human-friendly name set by an admin.
         * Displayed in the admin product-selection UI.
         * Never overwritten by syncs.
         */
        translatedName: {
            type: String,
            trim: true,
            default: null,
        },

        rawPrice: {
            type: String,
            required: [true, 'rawPrice is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        minQty: {
            type: Number,
            default: 1,
            min: [1, 'minQty must be at least 1'],
        },

        maxQty: {
            type: Number,
            default: 9999,
        },

        /**
         * Whether the provider reports this product as available.
         * A ProviderProduct with isActive=false should not be surfaced
         * for new Product publishing, but existing linked Products are
         * not automatically deactivated (admin decides).
         */
        isActive: {
            type: Boolean,
            default: true,
        },

        /** Timestamp of the most recent successful sync for this product. */
        lastSyncedAt: {
            type: Date,
            default: null,
        },

        /**
         * Full raw JSON payload returned by the provider for this product.
         * Stored verbatim so nothing is ever lost even if the schema evolves.
         */
        rawPayload: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    {
        timestamps: true,   // createdAt + updatedAt
        versionKey: false,
    }
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Primary uniqueness constraint: each (provider, externalProductId) pair is
 * globally unique. Prevents duplicate records from idempotent upserts.
 */
providerProductSchema.index(
    { provider: 1, externalProductId: 1 },
    { unique: true, name: 'unique_provider_external_product' }
);

/**
 * Admin product-selection screen: fetch all raw products for a given provider.
 */
providerProductSchema.index(
    { provider: 1, isActive: 1 },
    { name: 'provider_active_products' }
);

/**
 * Stale-sync detection: find all products that haven't been synced recently.
 */
providerProductSchema.index(
    { lastSyncedAt: 1 },
    { name: 'last_synced_at' }
);

const ProviderProduct = mongoose.model('ProviderProduct', providerProductSchema);

module.exports = { ProviderProduct };
