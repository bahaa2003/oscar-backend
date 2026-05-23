'use strict';

/**
 * category.controller.js
 *
 * Thin HTTP adapter — all logic lives in category.service.js.
 */

const svc = require('./category.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');

// GET /admin/categories
const listCategories = catchAsync(async (req, res) => {
    const categories = await svc.listCategories({ includeInactive: true });
    sendSuccess(res, { categories }, 'Categories retrieved');
});

// GET /admin/categories/:id
const getCategoryById = catchAsync(async (req, res) => {
    const category = await svc.getCategoryById(req.params.id);
    sendSuccess(res, { category }, 'Category retrieved');
});

// POST /admin/categories
const createCategory = catchAsync(async (req, res) => {
    const category = await svc.createCategory(req.body, req.user._id);
    sendCreated(res, { category }, 'Category created');
});

// PATCH /admin/categories/:id
const updateCategory = catchAsync(async (req, res) => {
    const category = await svc.updateCategory(req.params.id, req.body, req.user._id);
    sendSuccess(res, { category }, 'Category updated');
});

// PATCH /admin/categories/:id/toggle
const toggleCategory = catchAsync(async (req, res) => {
    const category = await svc.toggleCategory(req.params.id, req.user._id);
    sendSuccess(res, { category }, 'Category toggled');
});

// DELETE /admin/categories/:id
const deleteCategory = catchAsync(async (req, res) => {
    const result = await svc.deleteCategory(req.params.id, req.user._id);
    sendSuccess(res, result, 'Category deleted');
});

module.exports = {
    listCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    toggleCategory,
    deleteCategory,
};
