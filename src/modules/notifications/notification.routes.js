'use strict';

/**
 * notification.routes.js — Customer-facing Notification API
 *
 * All routes require:
 *  1. authenticate       — valid JWT
 *  2. requireActiveUser  — account status === ACTIVE
 *
 * Route map:
 *
 *  GET   /api/me/notifications             — My notifications (paginated)
 *  GET   /api/me/notifications/unread-count — Unread badge count
 *  PATCH /api/me/notifications/read-all    — Mark all as read
 *  PATCH /api/me/notifications/:id/read    — Mark one as read
 */

const { Router } = require('express');
const notifCtrl = require('./notification.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { validateQuery, schemas } = require('./notification.validation');

const router = Router();

// ── Global guards ─────────────────────────────────────────────────────────────
router.use(authenticate, requireActiveUser);

// ─── List My Notifications ────────────────────────────────────────────────────
router.get(
    '/',
    validateQuery(schemas.listMyNotifications),
    notifCtrl.getMyNotifications
);

// ─── Unread Count (badge) ─────────────────────────────────────────────────────
router.get('/unread-count', notifCtrl.getUnreadCount);

// ─── Mark All As Read ─────────────────────────────────────────────────────────
// NOTE: this MUST come before /:id/read to avoid route conflict
router.patch('/read-all', notifCtrl.markAllAsRead);

// ─── Mark One As Read ─────────────────────────────────────────────────────────
router.patch('/:id/read', notifCtrl.markAsRead);

module.exports = router;
