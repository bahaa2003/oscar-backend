'use strict';

const { Router } = require('express');
const controller = require('./provider.controller');
const {
    createProviderValidation,
    updateProviderValidation,
    providerIdParamValidation,
    providerProductListValidation,
    setTranslatedNameValidation,
    publishProductValidation,
    updatePublishedProductValidation,
} = require('./provider.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');

const router = Router();

// All provider routes are admin-only
router.use(authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_SUPPLIERS'));

// =============================================================================
// LAYER 1 — PROVIDER CRUD
// =============================================================================

/**
 * @route  GET  /api/providers
 * @desc   List all providers (pass ?includeInactive=true to see inactive)
 */
router.get('/', controller.listProviders);

/**
 * @route  POST /api/providers
 * @desc   Create a new provider
 * @body   { name, baseUrl, apiToken?, slug?, syncInterval?, isActive?, supportedFeatures? }
 */
router.post(
    '/',
    createProviderValidation, validate,
    controller.createProvider
);

/**
 * @route  GET  /api/providers/:id
 * @desc   Get a single provider by ID
 */
router.get(
    '/:id',
    providerIdParamValidation, validate,
    controller.getProvider
);

/**
 * @route  PATCH /api/providers/:id
 * @desc   Update provider fields (name, baseUrl, apiToken, syncInterval, etc.)
 */
router.patch(
    '/:id',
    updateProviderValidation, validate,
    controller.updateProvider
);

/**
 * @route  DELETE /api/providers/:id
 * @desc   Safely delete provider after detaching linked products
 */
router.delete(
    '/:id',
    authorize('ADMIN'),
    providerIdParamValidation, validate,
    controller.deleteProvider
);

// =============================================================================
// SYNC  (Layer 1 → 2)
// =============================================================================

/**
 * @route  POST /api/providers/:id/sync
 * @desc   Trigger a full product sync for this provider
 *         Calls GET /api/AllProducts on the provider API, upserts into
 *         provider_products, deactivates missing items, syncs prices.
 */
router.post(
    '/:id/sync',
    providerIdParamValidation, validate,
    controller.triggerSync
);

// =============================================================================
// LAYER 2 — RAW PROVIDER PRODUCTS  (admin product-selection screen)
// =============================================================================

/**
 * @route  GET  /api/providers/:id/products
 * @desc   List raw ProviderProducts for the given provider
 * @query  page, limit, includeInactive, search (partial name match)
 *
 * This is the BROWSE screen: admin sees all synced products before
 * deciding which to publish.
 */
router.get(
    '/:id/products',
    providerProductListValidation, validate,
    controller.listProviderProducts
);

/**
 * @route  GET  /api/providers/:id/products/:productId
 * @desc   Get a single raw ProviderProduct (detail view, shows rawPayload)
 */
router.get(
    '/:id/products/:productId',
    providerIdParamValidation, validate,
    controller.getProviderProduct
);

/**
 * @route  PATCH /api/providers/:id/products/:productId/translated-name
 * @desc   Set a human-friendly localised name (never overwritten by sync)
 * @body   { translatedName }
 */
router.patch(
    '/:id/products/:productId/translated-name',
    setTranslatedNameValidation, validate,
    controller.setTranslatedName
);

// =============================================================================
// LAYER 2 → 3  —  PUBLISH / UPDATE PLATFORM PRODUCTS
// =============================================================================

/**
 * @route  POST /api/providers/products/publish
 * @desc   Admin publishes a ProviderProduct as a public Platform Product.
 *         Supports markup configuration (percentage/fixed), qty override,
 *         image override, pricingMode (manual/sync), executionType.
 *
 * @body   {
 *   providerProductId: string,           // REQUIRED
 *   name:             string,            // REQUIRED — can differ from rawName
 *   description?:     string,
 *   pricingMode?:     'manual'|'sync',   // default: manual
 *   markupType?:      'percentage'|'fixed', // default: percentage
 *   markupValue?:     number,            // e.g. 20 = 20% markup
 *   basePrice?:       number,            // used in manual mode without markup
 *   minQty?:          number,
 *   maxQty?:          number,
 *   image?:           string (URL),
 *   executionType?:   'manual'|'automatic'
 * }
 *
 * NOTE: This route MUST be declared before /:id routes to avoid
 *       Express treating "products" as a :id param.
 */
router.post(
    '/products/publish',
    publishProductValidation, validate,
    controller.publishProduct
);

/**
 * @route  PATCH /api/providers/products/:productId
 * @desc   Admin updates a published Platform Product
 *         (name, price, markup, pricingMode, qty, image, status, etc.)
 */
router.patch(
    '/products/:productId',
    updatePublishedProductValidation, validate,
    controller.updatePublishedProduct
);

module.exports = router;
