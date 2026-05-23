'use strict';

/**
 * admin.validation.js
 *
 * Joi schemas + reusable validate() middleware for all admin API inputs.
 *
 * Usage in routes:
 *   router.patch('/users/:id', validateBody(schemas.updateUser), controller.updateUser);
 *
 * Validation strategy:
 *   - Body validation: validateBody()
 *   - Query validation: validateQuery()
 *   - Params are validated inline using Mongoose ObjectId casting (throws 404 on bad id)
 */

const Joi = require('joi');
const { BusinessRuleError } = require('../../shared/errors/AppError');

// ─── Reusable field definitions ───────────────────────────────────────────────

const objectId = () => Joi.string().hex().length(24).messages({
    'string.length': '{{#label}} must be a valid 24-character ObjectId',
    'string.hex': '{{#label}} must be a valid ObjectId (hex characters only)',
});

const pagination = {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
};

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns an Express middleware that validates req.body against `schema`.
 * Strips unknown fields (allowUnknown: false by default).
 */
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

/**
 * Returns an Express middleware that validates req.query against `schema`.
 */
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

// ─── User schemas ─────────────────────────────────────────────────────────────

const updateUserSchema = Joi.object({
    name: Joi.string().trim().min(2).max(64),
    email: Joi.string().email(),
    groupId: objectId().allow(null),
    status: Joi.string().valid('PENDING', 'ACTIVE', 'REJECTED'),
    verified: Joi.boolean(),
    creditLimit: Joi.number().min(0).messages({
        'number.min': 'Credit limit cannot be negative',
    }),
}).min(1).messages({ 'object.min': 'At least one field must be provided for update' });

const listUsersQuery = Joi.object({
    ...pagination,
    status: Joi.string().valid('PENDING', 'ACTIVE', 'REJECTED'),
    verified: Joi.boolean(),
    email: Joi.string().max(128),
    search: Joi.string().trim().max(128).allow('', null),
    role: Joi.string().valid('ADMIN', 'SUPERVISOR', 'CUSTOMER'),
    from: Joi.date().iso(),
    to: Joi.date().iso().min(Joi.ref('from')),
    sortBy: Joi.string().valid('createdAt', 'email', 'name', 'status', 'walletBalance').default('createdAt'),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
});

const updateUserRoleSchema = Joi.object({
    role: Joi.string().valid('ADMIN', 'SUPERVISOR', 'CUSTOMER').required().messages({
        'any.required': 'Role is required',
        'any.only': 'Role must be ADMIN, SUPERVISOR, or CUSTOMER',
    }),
});

const updateUserPermissionsSchema = Joi.object({
    permissions: Joi.array().items(
        Joi.string().trim().uppercase().max(64)
    ).required().messages({
        'any.required': 'Permissions array is required',
    }),
});

const updateUserCurrencySchema = Joi.object({
    currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/).required().messages({
        'any.required': 'Currency code is required',
        'string.pattern.base': 'Currency must be a 3-letter ISO 4217 code (e.g. USD, SAR)',
    }),
});

const updateCreditLimitSchema = Joi.object({
    creditLimit: Joi.number().min(0).required().messages({
        'number.min': 'Credit limit cannot be negative',
        'any.required': 'creditLimit is required',
    }),
});

const resetUserPasswordSchema = Joi.object({
    password: Joi.string().min(8).max(128).required().messages({
        'any.required': 'New password is required',
        'string.min': 'Password must be at least 8 characters',
    }),
});

const updateUserAvatarSchema = Joi.object({
    avatar: Joi.string().uri({ allowRelative: true }).allow('', null).required().messages({
        'any.required': 'Avatar URL is required (use null to remove)',
    }),
});

// ─── Provider schemas ─────────────────────────────────────────────────────────

const createProviderSchema = Joi.object({
    name: Joi.string().trim().min(2).max(64).required(),
    slug: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]+$/).max(64),
    baseUrl: Joi.string().uri().required(),
    apiToken: Joi.string().trim().max(4096),
    isActive: Joi.boolean().default(true),
    syncInterval: Joi.number().integer().min(0).default(60),
    supportedFeatures: Joi.array().items(Joi.string()).default([]),
});

const updateProviderSchema = Joi.object({
    name: Joi.string().trim().min(2).max(64),
    slug: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]+$/).max(64),
    baseUrl: Joi.string().uri(),
    apiToken: Joi.string().trim().max(4096).allow('', null),
    isActive: Joi.boolean(),
    syncInterval: Joi.number().integer().min(0),
    supportedFeatures: Joi.array().items(Joi.string()),
}).min(1);

// ─── Order schemas ────────────────────────────────────────────────────────────

const listOrdersQuery = Joi.object({
    ...pagination,
    status: Joi.string().valid('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELED', 'PARTIAL', 'MANUAL_REVIEW'),
    userId: objectId(),
    providerId: objectId(),
    search: Joi.string().allow('', null).optional(), // <--- البطل اللي هينقذ الموقف
    from: Joi.date().iso(),
    to: Joi.date().iso().min(Joi.ref('from')),
});

const updateOrderStatusSchema = Joi.object({
    status: Joi.string()
        .valid('completed', 'approved', 'failed', 'rejected', 'denied', 'refunded', 'cancelled', 'canceled', 'processing', 'retry', 'pending',
               'COMPLETED', 'APPROVED', 'FAILED', 'REJECTED', 'DENIED', 'REFUNDED', 'CANCELLED', 'CANCELED', 'PROCESSING', 'RETRY', 'PENDING')
        .required()
        .messages({
            'any.required': 'status is required',
            'any.only': 'Invalid target status. Use: completed, rejected, failed, processing.',
        }),
    rejectionReason: Joi.string().trim().max(500).optional().allow('', null),
});

// ─── Wallet schemas ───────────────────────────────────────────────────────────

const walletAdjustmentSchema = Joi.object({
    amount: Joi.number().positive().max(100_000).required().messages({
        'number.max': 'Maximum single adjustment is 100,000',
        'number.positive': 'Amount must be a positive number',
        'any.required': 'Amount is required',
    }),
    reason: Joi.string().trim().min(3).max(255).optional().messages({
        'string.min': 'Reason must be at least 3 characters',
    }),
    description: Joi.string().trim().min(3).max(255).optional().messages({
        'string.min': 'Description must be at least 3 characters',
    }),
}).or('reason', 'description');

const walletSetBalanceSchema = Joi.object({
    targetBalance: Joi.number().required().messages({
        'any.required': 'Target balance is required',
    }),
    reason: Joi.string().trim().min(3).max(255).optional().messages({
        'string.min': 'Reason must be at least 3 characters',
    }),
    description: Joi.string().trim().min(3).max(255).optional().messages({
        'string.min': 'Description must be at least 3 characters',
    }),
});

// ─── Group schemas ────────────────────────────────────────────────────────────

const createGroupSchema = Joi.object({
    name: Joi.string().trim().min(2).max(64).required(),
    percentage: Joi.number().min(0).max(1000).required(),
    billingMode: Joi.string().valid('standard', 'quantity_only').optional(),
    isActive: Joi.boolean().default(true),
});

const updateGroupSchema = Joi.object({
    name: Joi.string().trim().min(2).max(64),
    percentage: Joi.number().min(0).max(1000),
    billingMode: Joi.string().valid('standard', 'quantity_only').optional(),
    isActive: Joi.boolean(),
    applyDebtAdjustment: Joi.boolean().default(false),
}).min(1);

// ─── Currency schemas ─────────────────────────────────────────────────────────

const updateCurrencySchema = Joi.object({
    platformRate: Joi.number().positive().required().messages({
        'any.required': 'platformRate is required',
    }),
    markupPercentage: Joi.number().min(0).max(100),
    isActive: Joi.boolean(),
    applyDebtAdjustment: Joi.boolean().default(false),
}).min(1);

const createCurrencySchema = Joi.object({
    code: Joi.string().trim().uppercase().length(3).pattern(/^[A-Z]{3}$/).required().messages({
        'any.required': 'Currency code is required',
        'string.length': 'Currency code must be exactly 3 letters (e.g. USD, SAR)',
        'string.pattern.base': 'Currency code must be a 3-letter ISO 4217 code',
    }),
    name: Joi.string().trim().min(1).max(64).required().messages({
        'any.required': 'Currency name is required',
    }),
    symbol: Joi.string().trim().min(1).max(8).required().messages({
        'any.required': 'Currency symbol is required',
    }),
    platformRate: Joi.number().positive().required().messages({
        'any.required': 'platformRate is required',
    }),
    marketRate: Joi.number().positive().allow(null),
    markupPercentage: Joi.number().min(0).max(100).default(0),
    isActive: Joi.boolean().default(true),
});

// ─── Deposit schemas ──────────────────────────────────────────────────────────

const updateDepositSchema = Joi.object({
    requestedAmount: Joi.number().positive(),
}).min(1).messages({
    'object.min': 'At least one field must be provided for update',
});

const reviewDepositSchema = Joi.object({
    status: Joi.string().valid('APPROVED', 'REJECTED').required().messages({
        'any.required': 'status is required',
        'any.only': 'status must be APPROVED or REJECTED',
    }),
    adminNotes: Joi.string().trim().max(500).optional().allow('', null).messages({
        'string.max': 'adminNotes cannot exceed 500 characters',
    }),
});

// ─── Settings schema ──────────────────────────────────────────────────────────

const updateSettingSchema = Joi.object({
    value: Joi.alternatives().try(
        Joi.string(),
        Joi.number(),
        Joi.boolean(),
        Joi.array(),
        Joi.object()
    ).required().messages({ 'any.required': 'Setting value is required' }),
});

// ─── Deposit admin schema ─────────────────────────────────────────────────────

const approveDepositSchema = Joi.object({
    amount: Joi.number().positive().max(1_000_000).optional(),
    currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/).optional(),
    adminNotes: Joi.string().trim().max(500).optional().allow('', null),
});

// ─── Debt Adjustment schema ──────────────────────────────────────────────────

const debtAdjustmentSchema = Joi.object({
    percentage: Joi.number().positive().max(100).required().messages({
        'number.positive': 'Percentage must be a positive number',
        'number.max': 'Percentage cannot exceed 100',
        'any.required': 'Percentage is required',
    }),
    reason: Joi.string().trim().min(3).max(255).optional().messages({
        'string.min': 'Reason must be at least 3 characters',
    }),
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    validateBody,
    validateQuery,
    schemas: {
        // Users
        updateUser: updateUserSchema,
        listUsersQuery,
        updateUserRole: updateUserRoleSchema,
        updateUserCurrency: updateUserCurrencySchema,
        updateCreditLimit: updateCreditLimitSchema,
        resetUserPassword: resetUserPasswordSchema,
        updateUserAvatar: updateUserAvatarSchema,
        updateUserPermissions: updateUserPermissionsSchema,
        // Providers
        createProvider: createProviderSchema,
        updateProvider: updateProviderSchema,
        // Orders
        listOrdersQuery,
        updateOrderStatus: updateOrderStatusSchema,
        // Wallet
        walletAdjustment: walletAdjustmentSchema,
        walletSetBalance: walletSetBalanceSchema,
        // Groups
        createGroup: createGroupSchema,
        updateGroup: updateGroupSchema,
        // Currency
        updateCurrency: updateCurrencySchema,
        createCurrency: createCurrencySchema,
        // Deposits
        updateDeposit: updateDepositSchema,
        reviewDeposit: reviewDepositSchema,
        // Settings
        updateSetting: updateSettingSchema,
        // Deposits approval
        approveDeposit: approveDepositSchema,
        // Debt Adjustment
        debtAdjustment: debtAdjustmentSchema,
    },
};
