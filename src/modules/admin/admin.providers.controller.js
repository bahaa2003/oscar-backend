'use strict';

/**
 * admin.providers.controller.js
 */

const svc = require('./admin.providers.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');

// GET /admin/providers
const listProviders = catchAsync(async (req, res) => {
    const providers = await svc.listProviders({
        includeInactive: req.query.includeInactive !== 'false',
    });
    sendSuccess(res, { providers }, 'Providers retrieved');
});

// GET /admin/providers/:id
const getProviderById = catchAsync(async (req, res) => {
    const provider = await svc.getProviderById(req.params.id);
    sendSuccess(res, { provider }, 'Provider retrieved');
});

// POST /admin/providers
const createProvider = catchAsync(async (req, res) => {
    const provider = await svc.createProvider(req.body, req.user._id);
    sendCreated(res, { provider }, 'Provider created');
});

// PATCH /admin/providers/:id
const updateProvider = catchAsync(async (req, res) => {
    const provider = await svc.updateProvider(req.params.id, req.body, req.user._id);
    sendSuccess(res, { provider }, 'Provider updated');
});

// DELETE /admin/providers/:id
const deleteProvider = catchAsync(async (req, res) => {
    const provider = await svc.deleteProvider(req.params.id, req.user._id);
    sendSuccess(res, { provider }, 'Provider deleted');
});

// PATCH /admin/providers/:id/toggle
const toggleProvider = catchAsync(async (req, res) => {
    const provider = await svc.toggleProvider(req.params.id, req.user._id);
    sendSuccess(res, { provider, isActive: provider.isActive }, 'Provider toggled');
});

// GET /admin/providers/:id/balance
const getProviderBalance = catchAsync(async (req, res) => {
    const data = await svc.getProviderBalance(req.params.id);
    sendSuccess(res, data, 'Provider balance retrieved');
});

// GET /admin/providers/:id/products
const getProviderLiveProducts = catchAsync(async (req, res) => {
    const data = await svc.getProviderLiveProducts(req.params.id);
    sendSuccess(res, data, 'Provider products retrieved');
});

// POST /admin/providers/:id/test-connection
const testProviderConnection = catchAsync(async (req, res) => {
    const data = await svc.testProviderConnection(req.params.id);
    sendSuccess(res, data, data.success ? 'Connection successful' : 'Connection failed');
});

// GET /admin/providers/:providerId/products/:externalProductId/price
const getProductPrice = catchAsync(async (req, res) => {
    const data = await svc.getProductPrice(req.params.providerId, req.params.externalProductId);
    sendSuccess(res, data, data.found ? 'Price retrieved' : 'Product not found in provider catalog');
});

// GET /admin/providers/:id/check-order?orderId=123
const checkProviderOrder = catchAsync(async (req, res) => {
    const data = await svc.checkProviderOrder(req.params.id, req.query.orderId);
    sendSuccess(res, data, 'Order status retrieved');
});

module.exports = {
    listProviders,
    getProviderById,
    createProvider,
    updateProvider,
    deleteProvider,
    toggleProvider,
    getProviderBalance,
    getProviderLiveProducts,
    testProviderConnection,
    getProductPrice,
    checkProviderOrder,
};
