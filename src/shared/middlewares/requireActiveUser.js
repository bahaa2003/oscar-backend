'use strict';

const { AuthorizationError } = require('../errors/AppError');
const { USER_STATUS } = require('../../modules/users/user.model');

/**
 * requireActiveUser — defence-in-depth middleware for business-critical routes.
 *
 * Must be applied AFTER authenticate middleware (which sets req.user).
 *
 * Although authenticate already blocks non-ACTIVE users, this middleware
 * provides an additional explicit guard on routes that handle financial
 * operations (orders, wallet) — so that the access control requirement is
 * visible directly in the route definition file, not just in a shared
 * middleware farther up the chain.
 *
 * This also ensures correctness if authenticate.js is ever relaxed or if
 * a future code path bypasses it.
 *
 * Usage in route files:
 *   router.use(authenticate, requireActiveUser);
 *   — or per-route —
 *   router.post('/orders', authenticate, requireActiveUser, authorize('CUSTOMER'), ...);
 */
const requireActiveUser = (req, res, next) => {
    if (!req.user) {
        // Should never happen if authenticate runs first, but be defensive
        throw new AuthorizationError('Authentication required.');
    }

    if (req.user.status !== USER_STATUS.ACTIVE) {
        throw new AuthorizationError(
            'Your account is not active. Admin approval is required to access this resource.'
        );
    }

    next();
};

module.exports = requireActiveUser;
