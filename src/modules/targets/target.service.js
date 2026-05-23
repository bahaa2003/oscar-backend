'use strict';

const { TargetApp, TargetOrder, TARGET_ORDER_STATUS } = require('./target.model');
const { User } = require('../users/user.model');
const {
    NotFoundError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    TARGET_ORDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { notifyNewTargetOrder, notifyTargetApproved, notifyTargetRejected } = require('../notifications/notification.service');

const normalizeMethods = (methods) => {
    return [...new Set((methods || []).map((method) => String(method).trim()).filter(Boolean))];
};

const assertPaymentMethodAllowed = (app, paymentMethod) => {
    const normalizedPaymentMethod = String(paymentMethod).trim();
    const allowed = normalizeMethods(app.allowedPaymentMethods);

    if (!allowed.includes(normalizedPaymentMethod)) {
        throw new BusinessRuleError(
            `Payment method '${normalizedPaymentMethod}' is not allowed for ${app.name}.`,
            'PAYMENT_METHOD_NOT_ALLOWED'
        );
    }

    return normalizedPaymentMethod;
};

const toMoney = (value) => Number(Number(value).toFixed(2));

// =============================================================================
// TARGET APPS
// =============================================================================

const createTargetApp = async ({
    name,
    unitPrice,
    image = null,
    allowedPaymentMethods,
    isActive = true,
}) => {
    const app = await TargetApp.create({
        name,
        unitPrice,
        image,
        allowedPaymentMethods: normalizeMethods(allowedPaymentMethods),
        isActive,
    });

    return app;
};

const listTargetApps = async ({ includeInactive = true } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return TargetApp.find(filter).sort({ isActive: -1, name: 1 });
};

const updateTargetApp = async (appId, updates) => {
    const app = await TargetApp.findById(appId);
    if (!app) throw new NotFoundError('TargetApp');

    if (updates.name !== undefined) app.name = updates.name;
    if (updates.unitPrice !== undefined) app.unitPrice = updates.unitPrice;
    if (updates.image !== undefined) app.image = updates.image;
    if (updates.allowedPaymentMethods !== undefined) {
        app.allowedPaymentMethods = normalizeMethods(updates.allowedPaymentMethods);
    }
    if (updates.isActive !== undefined) app.isActive = updates.isActive;

    await app.save();
    return app;
};

const deactivateTargetApp = async (appId) => {
    const app = await TargetApp.findByIdAndUpdate(
        appId,
        { $set: { isActive: false } },
        { new: true }
    );
    if (!app) throw new NotFoundError('TargetApp');
    return app;
};

// =============================================================================
// TARGET ORDERS
// =============================================================================

const createTargetOrder = async ({
    userId,
    appId,
    coinAmount,
    senderId,
    transferNumber,
    paymentMethod,
    screenshotProof,
    auditContext = null,
}) => {
    const [user, app] = await Promise.all([
        User.findById(userId).select('_id'),
        TargetApp.findOne({ _id: appId, isActive: true }),
    ]);

    if (!user) throw new NotFoundError('User');
    if (!app) {
        throw new BusinessRuleError(
            'Target app does not exist or is inactive.',
            'TARGET_APP_NOT_AVAILABLE'
        );
    }

    const normalizedPaymentMethod = assertPaymentMethodAllowed(app, paymentMethod);
    const unitPrice = app.unitPrice;

    if (typeof unitPrice !== 'number' || unitPrice <= 0) {
        throw new BusinessRuleError(
            'Target app unit price is invalid. Please contact support.',
            'INVALID_UNIT_PRICE'
        );
    }

    const totalPrice = toMoney(coinAmount * unitPrice);

    const order = await TargetOrder.create({
        userId,
        appId: app._id,
        appNameSnapshot: app.name,
        coinAmount,
        senderId,
        transferNumber,
        paymentMethod: normalizedPaymentMethod,
        screenshotProof,
        totalPrice,
        unitPriceSnapshot: unitPrice,
        status: TARGET_ORDER_STATUS.PENDING,
    });

    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: TARGET_ORDER_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: order._id,
        metadata: {
            userId: userId.toString(),
            appId: app._id.toString(),
            appNameSnapshot: app.name,
            coinAmount,
            senderId,
            transferNumber,
            paymentMethod: normalizedPaymentMethod,
            totalPrice,
            unitPrice,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    notifyNewTargetOrder(order);

    return order;
};

const approveTargetOrder = async (orderId, adminId, auditContext = null) => {
    const existing = await TargetOrder.findById(orderId);
    if (!existing) throw new NotFoundError('TargetOrder');

    if (existing.status === TARGET_ORDER_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This target order has already been approved.',
            'TARGET_ORDER_ALREADY_APPROVED'
        );
    }
    if (existing.status === TARGET_ORDER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected target order cannot be approved. The customer must submit a new one.',
            'TARGET_ORDER_ALREADY_REJECTED'
        );
    }

    const updated = await TargetOrder.findOneAndUpdate(
        { _id: orderId, status: TARGET_ORDER_STATUS.PENDING },
        {
            $set: {
                status: TARGET_ORDER_STATUS.APPROVED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This target order has already been reviewed.',
            'TARGET_ORDER_ALREADY_REVIEWED'
        );
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: TARGET_ORDER_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            appId: updated.appId?.toString?.() ?? null,
            appNameSnapshot: updated.appNameSnapshot ?? null,
            coinAmount: updated.coinAmount,
            totalPrice: updated.totalPrice,
            unitPriceSnapshot: updated.unitPriceSnapshot,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    const populated = await TargetOrder.findById(updated._id)
        .populate('userId', 'name email currency walletBalance')
        .populate('appId', 'name image unitPrice allowedPaymentMethods isActive')
        .populate('reviewedBy', 'name email');

    notifyTargetApproved(populated);

    return populated;
};

const rejectTargetOrder = async (orderId, adminId, adminNotes = null, auditContext = null) => {
    const existing = await TargetOrder.findById(orderId);
    if (!existing) throw new NotFoundError('TargetOrder');

    if (existing.status === TARGET_ORDER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This target order has already been rejected.',
            'TARGET_ORDER_ALREADY_REJECTED'
        );
    }
    if (existing.status === TARGET_ORDER_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved target order cannot be rejected.',
            'TARGET_ORDER_ALREADY_APPROVED'
        );
    }

    const updated = await TargetOrder.findOneAndUpdate(
        { _id: orderId, status: TARGET_ORDER_STATUS.PENDING },
        {
            $set: {
                status: TARGET_ORDER_STATUS.REJECTED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
                adminNotes: adminNotes || null,
            },
        },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This target order has already been reviewed.',
            'TARGET_ORDER_ALREADY_REVIEWED'
        );
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: TARGET_ORDER_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.TARGET_ORDER,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            appId: updated.appId?.toString?.() ?? null,
            appNameSnapshot: updated.appNameSnapshot ?? null,
            coinAmount: updated.coinAmount,
            totalPrice: updated.totalPrice,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    const populated = await TargetOrder.findById(updated._id)
        .populate('userId', 'name email currency walletBalance')
        .populate('appId', 'name image unitPrice allowedPaymentMethods isActive')
        .populate('reviewedBy', 'name email');

    notifyTargetRejected(populated, adminNotes);

    return populated;
};

const listTargetOrders = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    if (status) filter.status = String(status).toUpperCase();

    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;

    const [orders, total, summaryStats] = await Promise.all([
        TargetOrder.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('appId', 'name image unitPrice allowedPaymentMethods isActive')
            .populate('reviewedBy', 'name email'),
        TargetOrder.countDocuments(filter),
        TargetOrder.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.APPROVED] }, 1, 0] } },
                    rejected: { $sum: { $cond: [{ $eq: ['$status', TARGET_ORDER_STATUS.REJECTED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0, rejected: 0 }),
    ]);

    return {
        orders,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalOrders: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
            rejectedCount: summaryStats.rejected,
        },
    };
};

const listMyTargetOrders = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = String(status).toUpperCase();

    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
        TargetOrder.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('appId', 'name image unitPrice allowedPaymentMethods isActive'),
        TargetOrder.countDocuments(filter),
    ]);

    return {
        orders,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

module.exports = {
    createTargetApp,
    listTargetApps,
    updateTargetApp,
    deactivateTargetApp,
    createTargetOrder,
    approveTargetOrder,
    rejectTargetOrder,
    listTargetOrders,
    listMyTargetOrders,
};
