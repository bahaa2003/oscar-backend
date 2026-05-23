'use strict';

/**
 * providerProduct.service.js
 *
 * Layer 2 service — ProviderProduct CRUD and admin queries.
 *
 * These records are INTERNAL ONLY. They are never exposed to end-users.
 * Admins browse them to decide which products to publish to the platform.
 *
 * Responsibilities:
 *   - List / search provider products (admin product-selection screen)
 *   - Update translatedName or other admin annotations
 *   - Get by ID (used by publish flow)
 */

const { ProviderProduct } = require('./providerProduct.model');
const { NotFoundError } = require('../../shared/errors/AppError');

// =============================================================================
// LIST / SEARCH
// =============================================================================

/**
 * listProviderProducts(filter, paginationOptions)
 *
 * Returns a paginated list of ProviderProducts.
 *
 * @param {Object} filter               - Mongoose filter (e.g. { provider, isActive })
 * @param {Object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.search]        - partial text match on rawName / translatedName
 * @returns {Promise<{ products, pagination }>}
 */
const listProviderProducts = async (filter = {}, { page = 1, limit = 500, search } = {}) => {
    const query = { ...filter };

    if (search) {
        const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ rawName: re }, { translatedName: re }];
    }

    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
        ProviderProduct.find(query)
            .sort({ rawName: 1 })
            .skip(skip)
            .limit(limit)
            .populate('provider', 'name slug'),
        ProviderProduct.countDocuments(query),
    ]);

    return {
        products,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

// =============================================================================
// GET ONE
// =============================================================================

/**
 * getProviderProductById(id)
 * Throws NotFoundError if missing.
 */
const getProviderProductById = async (id) => {
    const pp = await ProviderProduct.findById(id).populate('provider', 'name slug isActive');
    if (!pp) throw new NotFoundError('ProviderProduct');
    return pp;
};

// =============================================================================
// ADMIN ANNOTATIONS
// =============================================================================

/**
 * setTranslatedName(providerProductId, translatedName)
 *
 * Admin sets a human-friendly localised name for a raw provider product.
 * This value is NEVER overwritten by sync runs.
 *
 * @returns {Promise<ProviderProduct>}
 */
const setTranslatedName = async (providerProductId, translatedName) => {
    const pp = await ProviderProduct.findByIdAndUpdate(
        providerProductId,
        { $set: { translatedName: translatedName?.trim() || null } },
        { new: true, runValidators: true }
    );
    if (!pp) throw new NotFoundError('ProviderProduct');
    return pp;
};

module.exports = {
    listProviderProducts,
    getProviderProductById,
    setTranslatedName,
};
