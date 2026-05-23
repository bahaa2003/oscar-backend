'use strict';

const { Router } = require('express');
const productController = require('./product.controller');
const {
    productIdParam,
    listProductsValidation,
    createProductValidation,
    publishProductValidation,
    updateProductValidation,
} = require('./product.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requirePermission = require('../../shared/middlewares/requirePermission');

const router = Router();

// ─── Public / Authenticated (customers + admins) ──────────────────────────────

/**
 * @route  GET /api/products
 * @desc   List products. Customers see only active; admins see all.
 * @access Authenticated
 */
router.get(
    '/',
    authenticate,
    listProductsValidation, validate,
    productController.listProducts
);

/**
 * @route  GET /api/products/:id
 * @desc   Get a single product by ID
 * @access Authenticated
 */
router.get(
    '/:id',
    authenticate,
    productIdParam, validate,
    productController.getProduct
);

// ─── Admin only ───────────────────────────────────────────────────────────────

/**
 * @route  POST /api/products
 * @desc   Create a standalone platform product (no provider link)
 * @access Admin
 */
router.post(
    '/',
    authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_PRODUCTS'),
    createProductValidation, validate,
    productController.createProduct
);

/**
 * @route  POST /api/products/publish
 * @desc   Publish a ProviderProduct as a platform product
 *         (3-layer flow: admin selects raw product, sets markup, overrides)
 * @access Admin
 * @body   { providerProductId, name, pricingMode, markupType, markupValue,
 *           basePrice?, minQty?, maxQty?, image?, description?, executionType? }
 */
router.post(
    '/publish',
    authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_PRODUCTS'),
    publishProductValidation, validate,
    productController.publishProduct
);

/**
 * @route  PATCH /api/products/:id
 * @desc   Update a platform product (name, price, markup, pricingMode, qty, etc.)
 * @access Admin
 */
router.patch(
    '/:id',
    authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_PRODUCTS'),
    updateProductValidation, validate,
    productController.updateProduct
);

/**
 * @route  PATCH /api/products/:id/toggle-status
 * @desc   Activate or deactivate a product
 * @access Admin
 */
router.patch(
    '/:id/toggle-status',
    authenticate, authorize('ADMIN', 'SUPERVISOR'), requirePermission('MANAGE_PRODUCTS'),
    productIdParam, validate,
    productController.toggleStatus
);

module.exports = router;
