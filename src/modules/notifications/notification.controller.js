'use strict';

/**
 * notification.controller.js — Customer-facing notification handlers.
 *
 * All handlers operate on the authenticated user (req.user).
 */

const notificationService = require('./notification.service');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parsePage = (v) => Math.max(1, parseInt(v, 10) || 1);
const parseLimit = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20));

// =============================================================================
// GET /api/me/notifications  —  My notification inbox
// =============================================================================

const getMyNotifications = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);

    const result = await notificationService.getMyNotifications(req.user._id, { page, limit });

    res.status(200).json({
        success: true,
        message: 'Notifications retrieved.',
        data: result.notifications,
        unreadCount: result.unreadCount,
        pagination: result.pagination,
    });
});

// =============================================================================
// GET /api/me/notifications/unread-count  —  Badge counter
// =============================================================================

const getUnreadCount = catchAsync(async (req, res) => {
    const count = await notificationService.getUnreadCount(req.user._id);
    sendSuccess(res, { unreadCount: count }, 'Unread count retrieved.');
});

// =============================================================================
// PATCH /api/me/notifications/:id/read  —  Mark one as read
// =============================================================================

const markAsRead = catchAsync(async (req, res) => {
    const notification = await notificationService.markAsRead(req.params.id, req.user._id);
    sendSuccess(res, notification, 'Notification marked as read.');
});

// =============================================================================
// PATCH /api/me/notifications/read-all  —  Mark all as read
// =============================================================================

const markAllAsRead = catchAsync(async (req, res) => {
    const result = await notificationService.markAllAsRead(req.user._id);
    sendSuccess(res, result, 'All notifications marked as read.');
});

module.exports = {
    getMyNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
};
