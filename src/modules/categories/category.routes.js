'use strict';

/**
 * category.routes.js
 *
 * Routes for category management (admin) and public listing.
 *
 * Admin routes are registered via admin.routes.js (auth + ADMIN guard).
 * The public GET /api/categories route is registered directly in app.js.
 */

const router = require('express').Router();
const ctrl = require('./category.controller');
const { validateBody } = require('../admin/admin.validation');
const { createCategorySchema, updateCategorySchema } = require('./category.validation');

// All routes below are mounted at /admin/categories inside admin.routes.js
// They inherit authenticate + authorize('ADMIN') from the admin router.

router.get('/', ctrl.listCategories);
router.get('/:id', ctrl.getCategoryById);
router.post('/', validateBody(createCategorySchema), ctrl.createCategory);
router.patch('/:id', validateBody(updateCategorySchema), ctrl.updateCategory);
router.patch('/:id/toggle', ctrl.toggleCategory);
router.delete('/:id', ctrl.deleteCategory);

module.exports = router;
