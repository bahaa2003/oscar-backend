'use strict';

const Joi = require('joi');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const {
    RESELLER_APPLICATION_STATUS,
    BUSINESS_TYPES,
    SALES_CHANNELS,
    CONTACT_METHODS,
} = require('./resellerApplication.model');

const objectId = () => Joi.string().hex().length(24);

const pagination = {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
};

const validateBody = (schema) => (req, _res, next) => {
    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });
    if (error) {
        return next(new BusinessRuleError(error.details.map((item) => item.message).join('; '), 'VALIDATION_ERROR'));
    }
    req.body = value;
    next();
};

const validateQuery = (schema) => (req, _res, next) => {
    const { error, value } = schema.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });
    if (error) {
        return next(new BusinessRuleError(error.details.map((item) => item.message).join('; '), 'VALIDATION_ERROR'));
    }
    req.query = value;
    next();
};

const url = Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(300).allow('', null);

const submitApplication = Joi.object({
    businessName: Joi.string().trim().min(2).max(120).required(),
    businessType: Joi.string().trim().uppercase().valid(...Object.values(BUSINESS_TYPES)).default(BUSINESS_TYPES.INDIVIDUAL),
    country: Joi.string().trim().min(2).max(80).required(),
    city: Joi.string().trim().min(2).max(80).required(),
    expectedMonthlyVolume: Joi.alternatives().try(
        Joi.number().min(0),
        Joi.string().trim().pattern(/^\d+(\.\d+)?$/)
    ).default('0'),
    experienceSummary: Joi.string().trim().min(10).max(2000).required(),
    salesChannels: Joi.array().items(Joi.string().trim().uppercase().valid(...Object.values(SALES_CHANNELS))).max(6).default([SALES_CHANNELS.OTHER]),
    targetMarkets: Joi.array().items(Joi.string().trim().max(80)).max(10).default(['Local']),
    websiteUrl: url,
    socialProfileUrl: url,
    contactPhone: Joi.string().trim().min(6).max(40).required(),
    preferredContactMethod: Joi.string().trim().uppercase().valid(...Object.values(CONTACT_METHODS)).default(CONTACT_METHODS.WHATSAPP),
});

const historyQuery = Joi.object({
    ...pagination,
});

const adminListQuery = Joi.object({
    ...pagination,
    status: Joi.string().trim().uppercase().valid(...Object.values(RESELLER_APPLICATION_STATUS)),
    country: Joi.string().trim().max(80),
    businessType: Joi.string().trim().uppercase().valid(...Object.values(BUSINESS_TYPES)),
    dateFrom: Joi.date().iso(),
    dateTo: Joi.date().iso().min(Joi.ref('dateFrom')),
    search: Joi.string().trim().max(80).allow('', null),
});

const approveApplication = Joi.object({
    assignedGroupId: objectId().required(),
});

const rejectApplication = Joi.object({
    rejectionReason: Joi.string().trim().min(3).max(500).required(),
});

const suspendApplication = Joi.object({
    suspensionReason: Joi.string().trim().min(3).max(500).required(),
});

const reactivateApplication = Joi.object({
    assignedGroupId: objectId().optional(),
});

module.exports = {
    validateBody,
    validateQuery,
    schemas: {
        submitApplication,
        historyQuery,
        adminListQuery,
        approveApplication,
        rejectApplication,
        suspendApplication,
        reactivateApplication,
    },
};
