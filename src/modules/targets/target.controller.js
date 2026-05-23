'use strict';

const targetService = require('./target.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const parsePage = (v) => Math.max(1, parseInt(v, 10) || 1);
const parseLimit = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20));

const createTargetOrder = catchAsync(async (req, res) => {
    if (!req.file) {
        throw new BusinessRuleError(
            'Screenshot proof is required. Please upload a file.',
            'SCREENSHOT_REQUIRED'
        );
    }

    const { appId, coinAmount, senderId, transferNumber, paymentMethod } = req.body;
    const screenshotProof = `uploads/targets/${req.file.filename}`;

    const order = await targetService.createTargetOrder({
        userId: req.user._id,
        appId,
        coinAmount,
        senderId,
        transferNumber,
        paymentMethod,
        screenshotProof,
        auditContext: {
            actorId: req.user._id,
            actorRole: 'CUSTOMER',
            ipAddress: req.ip ?? null,
            userAgent: req.get('User-Agent') ?? null,
        },
    });

    sendCreated(res, order, 'Target order submitted successfully. Pending admin review.');
});

const getMyTargetOrders = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status } = req.query;

    const result = await targetService.listMyTargetOrders(req.user._id, { page, limit, status });
    sendPaginated(res, result.orders, result.pagination, 'Target orders retrieved.');
});

const getActiveTargetApps = catchAsync(async (_req, res) => {
    const apps = await targetService.listTargetApps({ includeInactive: false });
    sendSuccess(res, { apps }, 'Target apps retrieved.');
});

module.exports = {
    createTargetOrder,
    getMyTargetOrders,
    getActiveTargetApps,
};
