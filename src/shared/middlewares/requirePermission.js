'use strict';

const { AuthorizationError } = require('../errors/AppError');

/**
 * Permission-based access control middleware factory.
 *
 * Usage:  requirePermission('MANAGE_DEPOSITS')
 *
 * Access rules:
 *   1. ADMIN role → always passes (admin bypass).
 *   2. Any other role → passes ONLY if `req.user.permissions`
 *      includes the required `permissionName`.
 *
 * Must be used AFTER the `authenticate` middleware (req.user must exist).
 *
 * This complements the existing role-based `authorize()` middleware by
 * adding fine-grained, per-user permission checks — primarily intended
 * for the SUPERVISOR role.
 */
const requirePermission = (permissionName) => (req, res, next) => {
    if (!req.user) {
        throw new AuthorizationError('Authentication required before authorization.');
    }

    // Admin bypass — admins have implicit access to everything
    if (req.user.role === 'ADMIN') {
        return next();
    }

    // Check user-level permissions array
    if (req.user.permissions && req.user.permissions.includes(permissionName)) {
        return next();
    }

    throw new AuthorizationError(
        `You do not have the required permission: '${permissionName}'.`
    );
};

module.exports = requirePermission;
