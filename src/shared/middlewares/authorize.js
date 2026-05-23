'use strict';

const { AuthorizationError } = require('../errors/AppError');

/**
 * Role-based access control middleware factory.
 * Usage: authorize('ADMIN') or authorize('ADMIN', 'CUSTOMER')
 *
 * Must be used AFTER authenticate middleware.
 */
const authorize = (...roles) => (req, res, next) => {
    if (!req.user) {
        throw new AuthorizationError('Authentication required before authorization.');
    }

    if (!roles.includes(req.user.role)) {
        throw new AuthorizationError(
            `Role '${req.user.role}' is not allowed to access this resource.`
        );
    }

    next();
};

module.exports = authorize;
