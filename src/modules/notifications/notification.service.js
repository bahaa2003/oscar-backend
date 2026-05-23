'use strict';

/**
 * notification.service.js
 *
 * Core notification business logic.
 *
 * DESIGN PRINCIPLE — FIRE-AND-FORGET SAFETY:
 *   All public "notify*" methods are designed to be called without `await`
 *   (fire-and-forget). They catch their own errors and log them, ensuring
 *   that a notification failure NEVER crashes the parent transaction.
 *
 *   Example:
 *     notifyUser({ ... });         // ← no await, no .catch() needed
 *     notifyDepositApproved(dep);  // ← same — fully self-contained
 *
 * Service operations:
 *   ─ Low-level ─
 *   notifyUser()               — create a single user notification (safe)
 *   notifyBroadcast()          — create a broadcast notification (safe)
 *   notifyGroup()              — create notifications for all users in a group (safe)
 *
 *   ─ Business triggers ─
 *   notifyAccountApproved()    — user account approved
 *   notifyDepositApproved()    — deposit approved
 *   notifyDepositRejected()    — deposit rejected
 *   notifyTargetApproved()     — target order approved
 *   notifyTargetRejected()     — target order rejected
 *   notifyOrderCompleted()     — product order completed
 *   notifyOrderFailed()        — product order failed / refunded
 *
 *   ─ CRUD for endpoints ─
 *   getMyNotifications()       — paginated inbox (user + broadcasts)
 *   markAsRead()               — mark one notification as read
 *   markAllAsRead()            — mark all unread as read
 *   getUnreadCount()           — badge counter
 *   listAllNotifications()     — admin: paginated system-wide list
 *   adminSendNotification()    — admin: manual send (single / group / broadcast)
 */

const { Notification, NOTIFICATION_TYPE, NOTIFICATION_SCOPE } = require('./notification.model');
const { User } = require('../users/user.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');

// =============================================================================
// INTERNAL SAFE WRAPPER
// =============================================================================

/**
 * Wraps an async operation so it NEVER throws.
 * Logs errors to stderr with a [Notification] prefix.
 * Returns null on failure.
 * @private
 */
const _safe = (label, fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => {
                console.error(`[Notification] ${label} failed:`, err.message);
            });
        }
        return result;
    } catch (err) {
        console.error(`[Notification] ${label} sync error:`, err.message);
        return null;
    }
};

/**
 * Send a notification to all admin-review actors.
 * Used for business events that require operational attention.
 * SAFE: catches its own errors.
 */
const notifyAdminsAndSupervisors = ({ title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'SYSTEM' }) => {
    return _safe('notifyAdminsAndSupervisors', async () => {
        const recipients = await User.find({
            role: { $in: ['ADMIN', 'SUPERVISOR'] },
            deletedAt: null,
        }).select('_id').lean();

        if (!recipients.length) return [];

        const docs = recipients.map((user) => ({
            userId: user._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        }));

        return Notification.insertMany(docs, { ordered: false });
    });
};

// =============================================================================
// LOW-LEVEL CREATORS (fire-and-forget safe)
// =============================================================================

/**
 * Create a notification for a single user.
 * SAFE: catches its own errors — will never crash the caller.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string}          params.title
 * @param {string}          params.message
 * @param {string}          [params.type='INFO']
 * @param {string|null}     [params.link]
 * @param {string}          [params.source='SYSTEM']
 */
const notifyUser = ({ userId, title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'SYSTEM' }) => {
    return _safe('notifyUser', () =>
        Notification.create({
            userId,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        })
    );
};

/**
 * Create a broadcast notification visible to all users.
 * SAFE: catches its own errors.
 */
const notifyBroadcast = ({ title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'ADMIN' }) => {
    return _safe('notifyBroadcast', () =>
        Notification.create({
            userId: null,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.BROADCAST,
            link,
            source,
        })
    );
};

/**
 * Send a notification to all users in a specific group.
 * Uses insertMany for efficiency.
 * SAFE: catches its own errors.
 *
 * @param {string|ObjectId} groupId
 * @param {Object}          notification - { title, message, type?, link?, source? }
 */
const notifyGroup = (groupId, { title, message, type = NOTIFICATION_TYPE.INFO, link = null, source = 'ADMIN' }) => {
    return _safe('notifyGroup', async () => {
        const users = await User.find({ groupId, deletedAt: null }).select('_id').lean();
        if (!users.length) return [];

        const docs = users.map((u) => ({
            userId: u._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source,
        }));

        return Notification.insertMany(docs, { ordered: false });
    });
};

// =============================================================================
// BUSINESS TRIGGER HELPERS (fire-and-forget — no await needed)
// =============================================================================

/**
 * Notify user that their account has been approved.
 * @param {string|ObjectId} userId
 */
const notifyAccountApproved = (userId) => {
    return notifyUser({
        userId,
        title: 'Account Approved ✅',
        message: 'Your account has been approved! You can now access all platform features.',
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'ACCOUNT',
    });
};

/**
 * Notify user that their deposit has been approved.
 * @param {Object} deposit - DepositRequest document
 */
const notifyDepositApproved = (deposit) => {
    return notifyUser({
        userId: deposit.userId?._id ?? deposit.userId,
        title: 'Deposit Approved ✅',
        message: `Your deposit of ${deposit.requestedAmount} ${deposit.currency || 'USD'} has been approved and credited to your wallet.`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'DEPOSIT',
    });
};

/**
 * Notify admins/supervisors that a new deposit requires review.
 * @param {Object} deposit - DepositRequest document
 */
const notifyNewDeposit = (deposit) => {
    const amount = `${deposit.requestedAmount} ${deposit.currency || 'USD'}`;
    const customer = deposit.userId?.name || deposit.userNameSnapshot || 'A customer';

    return notifyAdminsAndSupervisors({
        title: 'New Deposit Request',
        message: `${customer} submitted a deposit request for ${amount}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/payments',
        source: 'DEPOSIT',
    });
};

/**
 * Notify user that their deposit has been rejected.
 * @param {Object} deposit - DepositRequest document
 * @param {string|null} [adminNotes]
 */
const notifyDepositRejected = (deposit, adminNotes = null) => {
    const reason = adminNotes ? ` Reason: ${adminNotes}` : '';
    return notifyUser({
        userId: deposit.userId?._id ?? deposit.userId,
        title: 'Deposit Rejected ❌',
        message: `Your deposit of ${deposit.requestedAmount} ${deposit.currency || 'USD'} has been rejected.${reason}`,
        type: NOTIFICATION_TYPE.ERROR,
        source: 'DEPOSIT',
    });
};

/**
 * Notify user that their target order has been approved.
 * @param {Object} order - TargetOrder document
 */
const notifyTargetApproved = (order) => {
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'Target Order Approved ✅',
        message: `Your target coin purchase of ${order.coinAmount} coins has been approved.`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'TARGET',
    });
};

/**
 * Notify user that their target order has been rejected.
 * @param {Object} order - TargetOrder document
 * @param {string|null} [adminNotes]
 */
const notifyTargetRejected = (order, adminNotes = null) => {
    const reason = adminNotes ? ` Reason: ${adminNotes}` : '';
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'Target Order Rejected ❌',
        message: `Your target coin purchase of ${order.coinAmount} coins has been rejected.${reason}`,
        type: NOTIFICATION_TYPE.ERROR,
        source: 'TARGET',
    });
};

/**
 * Notify admins/supervisors that a new target order requires review.
 * @param {Object} order - TargetOrder document
 */
const notifyNewTargetOrder = (order) => {
    const customer = order.userId?.name || order.userNameSnapshot || 'A customer';
    const appName = order.appNameSnapshot || order.appId?.name || 'Target app';
    const amount = order.coinAmount ?? 'requested';

    return notifyAdminsAndSupervisors({
        title: 'New Target Order',
        message: `${customer} submitted a target order for ${amount} coins on ${appName}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/target-requests',
        source: 'TARGET',
    });
};

/**
 * Notify user that their product order was completed.
 * @param {Object} order - Order document
 */
const notifyOrderCompleted = (order) => {
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'Order Completed ✅',
        message: `Your order ${label} has been completed successfully.`,
        type: NOTIFICATION_TYPE.SUCCESS,
        source: 'ORDER',
    });
};

/**
 * Notify user that their product order failed (with refund).
 * @param {Object} order - Order document
 */
const notifyOrderFailed = (order) => {
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    return notifyUser({
        userId: order.userId?._id ?? order.userId,
        title: 'Order Failed',
        message: `Your order ${label} has failed. A refund has been issued to your wallet.`,
        type: NOTIFICATION_TYPE.WARNING,
        source: 'ORDER',
    });
};

/**
 * Notify admins/supervisors that a manual product order requires fulfillment.
 * @param {Object} order - Order document
 */
const notifyNewManualOrder = (order) => {
    const label = order.orderNumber ? `#${order.orderNumber}` : '';
    const customer = order.userId?.name || order.userNameSnapshot || 'A customer';
    const productName = order.productId?.name || order.productNameSnapshot || 'Manual product';

    return notifyAdminsAndSupervisors({
        title: 'New Manual Order',
        message: `${customer} placed manual order ${label} for ${productName}.`,
        type: NOTIFICATION_TYPE.WARNING,
        link: '/admin/orders',
        source: 'ORDER',
    });
};

// =============================================================================
// CRUD — CUSTOMER ENDPOINTS
// =============================================================================

/**
 * Get notifications for a user (own + broadcasts), paginated.
 * Sorted newest-first. Includes unread badge count.
 */
const getMyNotifications = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    // Query: notifications targeted at this user OR broadcasts
    const filter = {
        $or: [
            { userId, scope: NOTIFICATION_SCOPE.USER },
            { scope: NOTIFICATION_SCOPE.BROADCAST },
        ],
    };

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({
            $or: [
                { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
                { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
            ],
        }),
    ]);

    return {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Mark a single notification as read.
 * Only the owner (or any user for broadcasts) can mark it.
 */
const markAsRead = async (notificationId, userId) => {
    const notification = await Notification.findById(notificationId);
    if (!notification) throw new NotFoundError('Notification');

    // Ownership check for user-scoped notifications
    if (
        notification.scope === NOTIFICATION_SCOPE.USER &&
        notification.userId?.toString() !== userId.toString()
    ) {
        throw new BusinessRuleError(
            'You can only mark your own notifications as read.',
            'NOT_YOUR_NOTIFICATION'
        );
    }

    if (notification.isRead) return notification;

    notification.isRead = true;
    await notification.save();
    return notification;
};

/**
 * Mark ALL unread notifications for a user as read.
 * Includes user-scoped and broadcast notifications.
 */
const markAllAsRead = async (userId) => {
    const result = await Notification.updateMany(
        {
            $or: [
                { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
                { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
            ],
        },
        { $set: { isRead: true } }
    );
    return { modifiedCount: result.modifiedCount };
};

/**
 * Get unread count for badge display.
 */
const getUnreadCount = async (userId) => {
    const count = await Notification.countDocuments({
        $or: [
            { userId, scope: NOTIFICATION_SCOPE.USER, isRead: false },
            { scope: NOTIFICATION_SCOPE.BROADCAST, isRead: false },
        ],
    });
    return count;
};

// =============================================================================
// CRUD — ADMIN ENDPOINTS
// =============================================================================

/**
 * Admin: list all notifications system-wide, paginated.
 */
const listAllNotifications = async ({ page = 1, limit = 20, scope, type } = {}) => {
    const filter = {};
    if (scope) filter.scope = scope;
    if (type) filter.type = type;

    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email')
            .lean(),
        Notification.countDocuments(filter),
    ]);

    return {
        notifications,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Admin: send a manual notification.
 *
 * Modes:
 *   - userId   → single user
 *   - groupId  → all users in a group (insertMany)
 *   - broadcast → all users (broadcast scope, single doc)
 *
 * @param {Object} params
 * @param {string|ObjectId|null} params.userId
 * @param {string|ObjectId|null} params.groupId
 * @param {boolean}              params.broadcast
 * @param {string}               params.title
 * @param {string}               params.message
 * @param {string}               [params.type='INFO']
 * @param {string|null}          [params.link]
 */
const adminSendNotification = async ({
    userId = null,
    groupId = null,
    broadcast = false,
    title,
    message,
    type = NOTIFICATION_TYPE.INFO,
    link = null,
}) => {
    // ── Broadcast ────────────────────────────────────────────────────────────
    if (broadcast) {
        const notification = await Notification.create({
            userId: null,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.BROADCAST,
            link,
            source: 'ADMIN',
        });
        return { sent: 1, mode: 'broadcast', notification };
    }

    // ── Group ────────────────────────────────────────────────────────────────
    if (groupId) {
        const users = await User.find({ groupId, deletedAt: null }).select('_id').lean();
        if (!users.length) {
            throw new BusinessRuleError(
                'No active users found in this group.',
                'GROUP_EMPTY'
            );
        }

        const docs = users.map((u) => ({
            userId: u._id,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source: 'ADMIN',
        }));

        const result = await Notification.insertMany(docs, { ordered: false });
        return { sent: result.length, mode: 'group', groupId };
    }

    // ── Single user ──────────────────────────────────────────────────────────
    if (userId) {
        const user = await User.findById(userId).select('_id');
        if (!user) throw new NotFoundError('User');

        const notification = await Notification.create({
            userId,
            title,
            message,
            type,
            scope: NOTIFICATION_SCOPE.USER,
            link,
            source: 'ADMIN',
        });
        return { sent: 1, mode: 'user', notification };
    }

    throw new BusinessRuleError(
        'You must specify a userId, groupId, or broadcast: true.',
        'MISSING_TARGET'
    );
};

module.exports = {
    // Low-level (fire-and-forget safe)
    notifyUser,
    notifyBroadcast,
    notifyGroup,

    // Business triggers (fire-and-forget safe)
    notifyAccountApproved,
    notifyNewDeposit,
    notifyDepositApproved,
    notifyDepositRejected,
    notifyNewTargetOrder,
    notifyTargetApproved,
    notifyTargetRejected,
    notifyNewManualOrder,
    notifyOrderCompleted,
    notifyOrderFailed,

    // CRUD — customer
    getMyNotifications,
    markAsRead,
    markAllAsRead,
    getUnreadCount,

    // CRUD — admin
    listAllNotifications,
    adminSendNotification,
};
