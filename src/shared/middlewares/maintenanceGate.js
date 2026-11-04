'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { User, USER_STATUS, ROLES } = require('../../modules/users/user.model');
const maintenanceService = require('../../modules/maintenance/maintenance.service');

const isAuthorizedAdmin = async (req) => {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;

    try {
        const token = authorization.slice(7).trim();
        const decoded = jwt.verify(token, config.jwt.secret);
        if (!decoded?.id || decoded.purpose === '2fa-pending') return false;
        const user = await User.findById(decoded.id).select('role status').lean();
        return user?.role === ROLES.ADMIN && user?.status === USER_STATUS.ACTIVE;
    } catch {
        return false;
    }
};

const isMaintenanceControlRequest = (req) => {
    const requestPath = String(req.originalUrl || '').split('?')[0];
    return requestPath === '/api/maintenance/status';
};

const maintenanceGate = async (req, res, next) => {
    try {
        const { enabled } = await maintenanceService.getStatus();
        if (!enabled || isMaintenanceControlRequest(req) || req.path.startsWith('/auth/')) return next();
        if (await isAuthorizedAdmin(req)) return next();

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        return res.status(503).json({
            success: false,
            code: 'MAINTENANCE_MODE',
            message: 'The store is temporarily unavailable while maintenance is in progress.',
        });
    } catch (error) {
        return next(error);
    }
};

module.exports = maintenanceGate;
module.exports.isAuthorizedAdmin = isAuthorizedAdmin;
