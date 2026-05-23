'use strict';

const providerService = require('./provider.service');
const providerProductService = require('./providerProduct.service');
const productService = require('../products/product.service');
const syncService = require('./sync.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// =============================================================================
// LAYER 1 — PROVIDER CRUD
// =============================================================================

/**
 * POST /api/providers
 */
const createProvider = catchAsync(async (req, res) => {
    const provider = await providerService.createProvider(req.body);
    sendCreated(res, provider, 'Provider created successfully.');
});

/**
 * GET /api/providers
 * ?includeInactive=true  →  show inactive providers too
 */
const listProviders = catchAsync(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const providers = await providerService.listProviders({ includeInactive });
    sendSuccess(res, providers);
});

/**
 * GET /api/providers/:id
 */
const getProvider = catchAsync(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);
    sendSuccess(res, provider);
});

/**
 * PATCH /api/providers/:id
 */
const updateProvider = catchAsync(async (req, res) => {
    const provider = await providerService.updateProvider(req.params.id, req.body);
    sendSuccess(res, provider, 'Provider updated.');
});

/**
 * DELETE /api/providers/:id
 */
const deleteProvider = catchAsync(async (req, res) => {
    const result = await providerService.deleteProvider(req.params.id);
    sendSuccess(res, result, 'Provider deleted and linked products detached.');
});

// =============================================================================
// LAYER 1 → 2 — SYNC (Populate ProviderProducts from provider API)
// =============================================================================

/**
 * POST /api/providers/:id/sync
 *
 * Manually trigger a full sync for this provider.
 * Calls GET /api/AllProducts on the provider, upserts into provider_products,
 * marks missing ones inactive, pushes price updates to sync-mode Products.
 */
const triggerSync = catchAsync(async (req, res) => {
    const result = await syncService.syncProviderProducts(req.params.id);
    sendSuccess(res, result, 'Provider sync completed.');
});

// =============================================================================
// LAYER 2 — PROVIDER PRODUCTS (raw, admin-only)
// =============================================================================

/**
 * GET /api/providers/:id/products
 *
 * Paginated list of raw ProviderProducts for the given provider.
 * Used by the admin product-selection screen.
 *
 * Query params: page, limit, includeInactive, search
 */
const listProviderProducts = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const includeInactive = req.query.includeInactive === 'true';
    const search = req.query.search?.trim() || undefined;

    const filter = { provider: req.params.id };
    if (!includeInactive) filter.isActive = true;

    const { products, pagination } = await providerProductService.listProviderProducts(
        filter,
        { page, limit, search }
    );

    sendPaginated(res, products, pagination, 'Provider products retrieved.');
});

/**
 * GET /api/providers/:id/products/:productId
 *
 * Single raw ProviderProduct detail view.
 */
const getProviderProduct = catchAsync(async (req, res) => {
    const pp = await providerProductService.getProviderProductById(req.params.productId);
    sendSuccess(res, pp);
});

/**
 * PATCH /api/providers/:id/products/:productId/translated-name
 *
 * Admin sets a human-friendly localised name.
 * This is never overwritten by future syncs.
 */
const setTranslatedName = catchAsync(async (req, res) => {
    const pp = await providerProductService.setTranslatedName(
        req.params.productId,
        req.body.translatedName
    );
    sendSuccess(res, pp, 'Translated name updated.');
});

// =============================================================================
// LAYER 2 → 3 — PUBLISH (Create Platform Product from ProviderProduct)
// =============================================================================

/**
 * POST /api/providers/products/publish
 *
 * Admin selects a ProviderProduct and publishes it as a public platform Product.
 * Admin may override name, qty, image, and configure markup.
 *
 * Body: { providerProductId, name, pricingMode?, markupType?, markupValue?,
 *         basePrice?, minQty?, maxQty?, image?, description?, executionType? }
 */
const publishProduct = catchAsync(async (req, res) => {
    const product = await productService.publishFromProviderProduct(req.body, req.user._id);
    sendCreated(res, product, 'Product published successfully.');
});

/**
 * PATCH /api/providers/products/:productId
 *
 * Admin updates a published platform Product.
 * Markup-aware price recalculation is applied automatically.
 */
const updatePublishedProduct = catchAsync(async (req, res) => {
    const product = await productService.updateProduct(req.params.productId, req.body);
    sendSuccess(res, product, 'Product updated.');
});

module.exports = {
    // Layer 1
    createProvider,
    listProviders,
    getProvider,
    updateProvider,
    deleteProvider,
    // Sync
    triggerSync,
    // Layer 2
    listProviderProducts,
    getProviderProduct,
    setTranslatedName,
    // Layer 2 → 3
    publishProduct,
    updatePublishedProduct,
};
