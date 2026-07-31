'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const referralDashboardService = require('./referralDashboard.service');
const referralPayoutService = require('./referralPayout.service');

const getMyDashboard = catchAsync(async (req, res) => {
    const data = await referralDashboardService.getDashboardForReferrer(req.user._id);
    return sendSuccess(res, data, 'Referral dashboard retrieved');
});

const listMyCommissions = catchAsync(async (req, res) => {
    const data = await referralDashboardService.listDashboardCommissionsForReferrer(req.user._id, req.query);
    return sendSuccess(res, data, 'Referral commissions retrieved');
});

const listMyInvitees = catchAsync(async (req, res) => {
    const data = await referralDashboardService.listInviteesForReferrer(req.user._id, req.query);
    return sendSuccess(res, data, 'Referral invitees retrieved');
});

const createMyPayout = catchAsync(async (req, res) => {
    const payout = await referralPayoutService.createPayoutRequest(
        req.user._id,
        {
            commissionIds: req.body.commissionIds,
            method: req.body.method,
        },
        { actorId: req.user._id, actorRole: 'CUSTOMER', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    return sendSuccess(res, referralPayoutService.serializePayoutForUser(payout), 'Referral payout request submitted');
});

const listMyPayouts = catchAsync(async (req, res) => {
    const data = await referralPayoutService.listPayoutsForReferrer(req.user._id, req.query);
    return sendSuccess(res, data, 'Referral payout requests retrieved');
});

const getMyPayout = catchAsync(async (req, res) => {
    const data = await referralPayoutService.getPayoutForReferrer(req.user._id, req.params.id);
    return sendSuccess(res, data, 'Referral payout request retrieved');
});

module.exports = {
    getMyDashboard,
    listMyCommissions,
    listMyInvitees,
    createMyPayout,
    listMyPayouts,
    getMyPayout,
};
