'use strict';

/**
 * notification.validation.js
 *
 * Joi schemas for notification endpoints.
 */

const Joi = require('joi');
const mongoose = require('mongoose');
const { BusinessRuleError } = require('../../shared/errors/AppError');

// ─── Middleware factories ─────────────────────────────────────────────────────

const validateBody = (schema) => (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });
    if (error) {
        const message = error.details.map((d) => d.message).join('; ');
        return next(new BusinessRuleError(message, 'VALIDATION_ERROR'));
    }
    req.body = value;
    next();
};

const validateQuery = (schema) => (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });
    if (error) {
        const message = error.details.map((d) => d.message).join('; ');
        return next(new BusinessRuleError(message, 'VALIDATION_ERROR'));
    }
    req.query = value;
    next();
};

// ─── Reusable ─────────────────────────────────────────────────────────────────

const pagination = {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
};

const objectId = Joi.string().custom((value, helpers) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        return helpers.error('any.invalid');
    }
    return value;
}, 'ObjectId validation');

// ─── Customer: List Notifications ─────────────────────────────────────────────

const listMyNotificationsQuery = Joi.object({
    ...pagination,
});

// ─── Admin: List All Notifications ────────────────────────────────────────────

const listAllNotificationsQuery = Joi.object({
    ...pagination,
    scope: Joi.string().valid('USER', 'BROADCAST').optional(),
    type: Joi.string().valid('INFO', 'SUCCESS', 'WARNING', 'ERROR').optional(),
});

// ─── Admin: Send Notification ─────────────────────────────────────────────────

const adminSendNotificationSchema = Joi.object({
    userId: objectId.optional().allow(null).messages({
        'any.invalid': 'userId must be a valid ObjectId',
    }),
    groupId: objectId.optional().allow(null).messages({
        'any.invalid': 'groupId must be a valid ObjectId',
    }),
    broadcast: Joi.boolean().optional().default(false),
    title: Joi.string().trim().min(1).max(200).required().messages({
        'string.empty': 'title is required',
        'string.max': 'title cannot exceed 200 characters',
        'any.required': 'title is required',
    }),
    message: Joi.string().trim().min(1).max(2000).required().messages({
        'string.empty': 'message is required',
        'string.max': 'message cannot exceed 2000 characters',
        'any.required': 'message is required',
    }),
    type: Joi.string().valid('INFO', 'SUCCESS', 'WARNING', 'ERROR').default('INFO').messages({
        'any.only': 'type must be one of: INFO, SUCCESS, WARNING, ERROR',
    }),
    link: Joi.string().trim().max(500).optional().allow('', null),
}).custom((value, helpers) => {
    // Ensure at least one target is specified
    const { userId, groupId, broadcast } = value;
    if (!userId && !groupId && !broadcast) {
        return helpers.error('any.custom', {
            message: 'You must specify a userId, groupId, or set broadcast to true.',
        });
    }
    // Ensure only one target mode is used
    const targets = [!!userId, !!groupId, !!broadcast].filter(Boolean);
    if (targets.length > 1) {
        return helpers.error('any.custom', {
            message: 'Specify only ONE of: userId, groupId, or broadcast.',
        });
    }
    return value;
}).messages({
    'any.custom': '{#message}',
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    validateBody,
    validateQuery,
    schemas: {
        listMyNotifications: listMyNotificationsQuery,
        listAllNotifications: listAllNotificationsQuery,
        adminSendNotification: adminSendNotificationSchema,
    },
};
