'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const catchAsync = require('../../shared/utils/catchAsync');
const maintenanceService = require('./maintenance.service');
const { isAuthorizedAdmin } = require('../../shared/middlewares/maintenanceGate');

const router = Router();
const preventCaching = (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
};

router.get('/status', preventCaching, catchAsync(async (req, res) => {
    const [status, canBypass] = await Promise.all([
        maintenanceService.getStatus(),
        isAuthorizedAdmin(req),
    ]);
    res.status(200).json({ success: true, data: { ...status, canBypass } });
}));

router.patch('/status', authenticate, authorize('ADMIN'), preventCaching, catchAsync(async (req, res) => {
    const status = await maintenanceService.setStatus(req.body?.enabled, req.user._id);
    res.status(200).json({ success: true, message: 'Maintenance mode updated.', data: { ...status, canBypass: true } });
}));

module.exports = router;
