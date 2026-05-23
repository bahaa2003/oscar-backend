'use strict';

const orderService = require('./order.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

const resolveAuditContext = (req) => req.auditContext ?? {
    actorId: req.user?._id,
    actorRole: String(req.user?.role || '').toUpperCase(),
    ipAddress: req.ip ?? null,
    userAgent: req.get('User-Agent') ?? null,
};

const normalizeCustomInputsPayload = (customInputs) => {
    if (!customInputs) return {};

    if (Array.isArray(customInputs)) {
        return customInputs.reduce((acc, item) => {
            if (!item || typeof item !== 'object') return acc;

            const fieldKey = String(
                item.key ?? item.name ?? item.label ?? item.field ?? item.id ?? ''
            ).trim();
            if (!fieldKey) return acc;

            const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
            const resolvedValue = hasValue
                ? item.value
                : (item.input ?? item.answer ?? item.data);

            if (resolvedValue !== undefined) {
                acc[fieldKey] = resolvedValue;
            }

            return acc;
        }, {});
    }

    if (typeof customInputs === 'object') {
        return { ...customInputs };
    }

    return {};
};

// ── Customer Endpoints ────────────────────────────────────────────────────────

const createOrder = catchAsync(async (req, res) => {
    const { productId, quantity, orderFieldsValues, customInputs, link, target } = req.body;

    // Merge top-level link/target into orderFieldsValues so they always
    // reach customerInput (SMM providers need these as provider params).
    const normalizedOrderFieldsValues = (orderFieldsValues && typeof orderFieldsValues === 'object' && !Array.isArray(orderFieldsValues))
        ? orderFieldsValues
        : {};
    const mergedFields = {
        ...normalizedOrderFieldsValues,
        ...normalizeCustomInputsPayload(customInputs),
    };
    if (link && !mergedFields.link) mergedFields.link = link;
    if (target && !mergedFields.target) mergedFields.target = target;
    const finalFields = Object.keys(mergedFields).length > 0 ? mergedFields : null;

    // Extract optional idempotency key from header
    const idempotencyKey = req.headers['idempotency-key'] || null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: 'CUSTOMER',
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10),
        idempotencyKey,
        orderFieldsValues: finalFields,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, order, 'Order already exists (idempotent response).');
    }

    sendCreated(res, order, 'Order placed successfully.');
});

const getMyOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { orders, pagination } = await orderService.listOrdersForUser(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, orders, pagination, 'Orders retrieved successfully.');
});

const getMyOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, order);
});

// ── Admin Endpoints ───────────────────────────────────────────────────────────

const getAllOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    const { orders, pagination } = await orderService.listAllOrders({ page, limit, status });
    sendPaginated(res, orders, pagination, 'Orders retrieved successfully.');
});

const adminGetOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id);
    sendSuccess(res, order);
});

const failOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsFailed(req.params.id, resolveAuditContext(req));
    sendSuccess(res, order, 'Order marked as failed and refund issued.');
});

const completeOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsCompleted(req.params.id, resolveAuditContext(req));
    sendSuccess(res, order, 'Order marked as completed.');
});

module.exports = {
    createOrder,
    getMyOrders,
    getMyOrder,
    getAllOrders,
    adminGetOrder,
    failOrder,
    completeOrder,
};
