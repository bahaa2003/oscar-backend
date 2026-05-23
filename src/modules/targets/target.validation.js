'use strict';

const Joi = require('joi');
const { BusinessRuleError } = require('../../shared/errors/AppError');

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

const objectId = () => Joi.string().hex().length(24).messages({
    'string.length': '{{#label}} must be a valid 24-character ObjectId',
    'string.hex': '{{#label}} must be a valid ObjectId',
});

const pagination = {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
};

const paymentMethod = Joi.string().trim().min(1).max(64).messages({
    'string.empty': 'Payment method cannot be empty',
    'string.max': 'Payment method cannot exceed 64 characters',
});

const paymentMethodsArray = Joi.array().items(paymentMethod.required()).min(1).unique();

const paymentMethodsField = Joi.alternatives().try(
    paymentMethodsArray,
    Joi.string().custom((value, helpers) => {
        try {
            const parsed = JSON.parse(value);
            const { error, value: normalized } = paymentMethodsArray.validate(parsed, {
                abortEarly: false,
                convert: true,
            });
            if (error) return helpers.error('any.invalid');
            return normalized;
        } catch (_err) {
            return helpers.error('any.invalid');
        }
    }, 'JSON array parser')
).messages({
    'any.invalid': 'allowedPaymentMethods must be an array or a JSON array string',
});

const createTargetOrderSchema = Joi.object({
    appId: objectId().required().messages({
        'any.required': 'appId is required',
    }),
    coinAmount: Joi.number().integer().min(1).required().messages({
        'number.base': 'coinAmount must be a number',
        'number.integer': 'coinAmount must be a whole number',
        'number.min': 'coinAmount must be at least 1',
        'any.required': 'coinAmount is required',
    }),
    senderId: Joi.string().trim().min(1).max(64).required().messages({
        'string.empty': 'senderId is required',
        'string.max': 'senderId cannot exceed 64 characters',
        'any.required': 'senderId is required',
    }),
    transferNumber: Joi.string().trim().min(1).max(64).required().messages({
        'string.empty': 'transferNumber is required',
        'string.max': 'transferNumber cannot exceed 64 characters',
        'any.required': 'transferNumber is required',
    }),
    paymentMethod: paymentMethod.required().messages({
        'any.required': 'paymentMethod is required',
    }),
});

const createTargetAppSchema = Joi.object({
    name: Joi.string().trim().min(1).max(120).required().messages({
        'string.empty': 'name is required',
        'string.max': 'name cannot exceed 120 characters',
        'any.required': 'name is required',
    }),
    unitPrice: Joi.number().positive().required().messages({
        'number.positive': 'unitPrice must be greater than 0',
        'any.required': 'unitPrice is required',
    }),
    image: Joi.string().trim().max(2048).allow('', null),
    allowedPaymentMethods: paymentMethodsField.required().messages({
        'any.required': 'allowedPaymentMethods is required',
    }),
    isActive: Joi.boolean().default(true),
});

const updateTargetAppSchema = Joi.object({
    name: Joi.string().trim().min(1).max(120),
    unitPrice: Joi.number().positive(),
    image: Joi.string().trim().max(2048).allow('', null),
    allowedPaymentMethods: paymentMethodsField,
    isActive: Joi.boolean(),
}).min(1).messages({
    'object.min': 'At least one field must be provided for update',
});

const listMyTargetOrdersQuery = Joi.object({
    ...pagination,
    status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').optional(),
});

const listTargetOrdersQuery = Joi.object({
    ...pagination,
    status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').optional(),
    search: Joi.string().allow('', null).optional(),
});

const rejectTargetOrderSchema = Joi.object({
    adminNotes: Joi.string().trim().max(500).optional().allow('', null).messages({
        'string.max': 'adminNotes cannot exceed 500 characters',
    }),
});

module.exports = {
    validateBody,
    validateQuery,
    schemas: {
        createTargetOrder: createTargetOrderSchema,
        createTargetApp: createTargetAppSchema,
        updateTargetApp: updateTargetAppSchema,
        listMyTargetOrders: listMyTargetOrdersQuery,
        listTargetOrders: listTargetOrdersQuery,
        rejectTargetOrder: rejectTargetOrderSchema,
    },
};
