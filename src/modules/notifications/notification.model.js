'use strict';

const mongoose = require('mongoose');

/**
 * Notification types — semantic colour / severity classification.
 * Maps directly to frontend toast/alert variants.
 */
const NOTIFICATION_TYPE = Object.freeze({
    INFO: 'INFO',
    SUCCESS: 'SUCCESS',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
});

/**
 * Notification scope — determines visibility/routing.
 *   USER       — targeted at a specific userId
 *   BROADCAST  — visible to all users (userId is null)
 */
const NOTIFICATION_SCOPE = Object.freeze({
    USER: 'USER',
    BROADCAST: 'BROADCAST',
});

const notificationSchema = new mongoose.Schema(
    {
        /**
         * Target user.
         * Null for BROADCAST notifications (shown to all users).
         * Populated for USER-scoped notifications.
         */
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },

        /** Notification title — short, action-oriented headline. */
        title: {
            type: String,
            required: [true, 'title is required'],
            trim: true,
            maxlength: [200, 'title cannot exceed 200 characters'],
        },

        /** Detailed message body. */
        message: {
            type: String,
            required: [true, 'message is required'],
            trim: true,
            maxlength: [2000, 'message cannot exceed 2000 characters'],
        },

        /** Semantic type / severity. */
        type: {
            type: String,
            enum: {
                values: Object.values(NOTIFICATION_TYPE),
                message: `type must be one of: ${Object.values(NOTIFICATION_TYPE).join(', ')}`,
            },
            default: NOTIFICATION_TYPE.INFO,
        },

        /** Visibility scope. */
        scope: {
            type: String,
            enum: {
                values: Object.values(NOTIFICATION_SCOPE),
                message: `scope must be one of: ${Object.values(NOTIFICATION_SCOPE).join(', ')}`,
            },
            default: NOTIFICATION_SCOPE.USER,
        },

        /** Read status — flipped to true by the recipient. */
        isRead: {
            type: Boolean,
            default: false,
        },

        /** Optional link — deep-link for frontend navigation (e.g. '/orders/xyz'). */
        link: {
            type: String,
            trim: true,
            maxlength: [500, 'link cannot exceed 500 characters'],
            default: null,
        },

        /** Source that triggered this notification. */
        source: {
            type: String,
            trim: true,
            maxlength: [100, 'source cannot exceed 100 characters'],
            default: 'SYSTEM',
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Primary query: user inbox — "my unread notifications, newest first"
 * Also covers "all my notifications" and count-unread badge.
 */
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

/**
 * Broadcast feed: latest broadcasts for the notification bell.
 */
notificationSchema.index({ scope: 1, createdAt: -1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = { Notification, NOTIFICATION_TYPE, NOTIFICATION_SCOPE };
