'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const service = require('./resellerApplication.service');

const auditContextFor = (req) => ({
    actorId: req.user._id,
    actorRole: String(req.user.role || 'CUSTOMER').toUpperCase(),
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
});

const submitMine = catchAsync(async (req, res) => {
    const application = await service.submitApplication(req.user._id, req.body, auditContextFor(req));
    return sendSuccess(res, { application: service.serializeApplicationForUser(application) }, 'Reseller application submitted', 201);
});

const getMyCurrent = catchAsync(async (req, res) => {
    const data = await service.getCurrentForUser(req.user._id);
    return sendSuccess(res, data, 'Current reseller application state retrieved');
});

const listMyHistory = catchAsync(async (req, res) => {
    const data = await service.listHistoryForUser(req.user._id, req.query);
    return sendSuccess(res, data, 'Reseller application history retrieved');
});

const listForAdmin = catchAsync(async (req, res) => {
    const data = await service.listApplicationsForAdmin(req.query);
    return sendSuccess(res, data, 'Reseller applications retrieved');
});

const getForAdmin = catchAsync(async (req, res) => {
    const data = await service.getApplicationForAdmin(req.params.id);
    return sendSuccess(res, data, 'Reseller application retrieved');
});

const approve = catchAsync(async (req, res) => {
    const application = await service.approveApplication(
        req.params.id,
        req.user._id,
        { assignedGroupId: req.body.assignedGroupId },
        auditContextFor(req)
    );
    return sendSuccess(res, { application: service.serializeApplicationForAdmin(application) }, 'Reseller application approved');
});

const reject = catchAsync(async (req, res) => {
    const application = await service.rejectApplication(
        req.params.id,
        req.user._id,
        { rejectionReason: req.body.rejectionReason },
        auditContextFor(req)
    );
    return sendSuccess(res, { application: service.serializeApplicationForAdmin(application) }, 'Reseller application rejected');
});

const suspend = catchAsync(async (req, res) => {
    const application = await service.suspendApplication(
        req.params.id,
        req.user._id,
        { suspensionReason: req.body.suspensionReason },
        auditContextFor(req)
    );
    return sendSuccess(res, { application: service.serializeApplicationForAdmin(application) }, 'Reseller account suspended');
});

const reactivate = catchAsync(async (req, res) => {
    const application = await service.reactivateApplication(
        req.params.id,
        req.user._id,
        { assignedGroupId: req.body.assignedGroupId },
        auditContextFor(req)
    );
    return sendSuccess(res, { application: service.serializeApplicationForAdmin(application) }, 'Reseller account reactivated');
});

module.exports = {
    submitMine,
    getMyCurrent,
    listMyHistory,
    listForAdmin,
    getForAdmin,
    approve,
    reject,
    suspend,
    reactivate,
};
