'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const referralAdminDashboardService = require('./referralAdminDashboard.service');

const getDashboard = catchAsync(async (_req, res) => {
    const data = await referralAdminDashboardService.getAdminReferralDashboard();
    return sendSuccess(res, data, 'Admin referral dashboard retrieved');
});

module.exports = {
    getDashboard,
};
