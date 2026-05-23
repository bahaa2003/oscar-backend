'use strict';

const auditService = require('./audit.service');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { ENTITY_TYPES } = require('./audit.constants');
const { BusinessRuleError } = require('../../shared/errors/AppError');

/**
 * GET /api/audit/entity/:type/:id
 *
 * Returns the chronological audit timeline for a specific entity.
 * entityType must be a valid ENTITY_TYPES constant.
 */
const getEntityLogs = catchAsync(async (req, res) => {
    const { type, id } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    if (!Object.values(ENTITY_TYPES).includes(type.toUpperCase())) {
        throw new BusinessRuleError(
            `Invalid entity type '${type}'. Must be one of: ${Object.values(ENTITY_TYPES).join(', ')}`,
            'INVALID_ENTITY_TYPE'
        );
    }

    const result = await auditService.getEntityAuditLogs(
        type.toUpperCase(),
        id,
        { page, limit }
    );

    sendPaginated(res, result.logs, result.pagination, 'Audit logs retrieved.');
});

/**
 * GET /api/audit/actor/:id
 *
 * Returns all audit entries where the given user is the actor.
 */
const getActorLogs = catchAsync(async (req, res) => {
    const { id } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const result = await auditService.getActorAuditLogs(id, { page, limit });

    sendPaginated(res, result.logs, result.pagination, 'Actor audit logs retrieved.');
});

module.exports = { getEntityLogs, getActorLogs };
