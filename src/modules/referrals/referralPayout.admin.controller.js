'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const referralPayoutService = require('./referralPayout.service');

const auditContextFor = (req) => ({
    actorId: req.user._id,
    actorRole: String(req.user.role || 'ADMIN').toUpperCase(),
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
});

const listPayouts = catchAsync(async (req, res) => {
    const data = await referralPayoutService.listPayoutsForAdmin(req.query);
    return sendSuccess(res, data, 'Referral payout requests retrieved');
});

const getPayout = catchAsync(async (req, res) => {
    const data = await referralPayoutService.getPayoutForAdmin(req.params.id);
    return sendSuccess(res, data, 'Referral payout request retrieved');
});

const rejectPayout = catchAsync(async (req, res) => {
    const payout = await referralPayoutService.rejectPayout(
        req.params.id,
        req.user._id,
        { rejectionReason: req.body.rejectionReason || req.body.reason || null },
        auditContextFor(req)
    );
    return sendSuccess(res, referralPayoutService.serializePayoutForAdmin(payout), 'Referral payout request rejected');
});

const settlePayout = catchAsync(async (req, res) => {
    const payout = await referralPayoutService.settlePayout(
        req.params.id,
        req.user._id,
        {
            externalReference: req.body.externalReference || null,
            settlementNote: req.body.settlementNote || req.body.manualSettlementNote || null,
        },
        auditContextFor(req)
    );
    return sendSuccess(res, referralPayoutService.serializePayoutForAdmin(payout), 'Referral payout request settled');
});

module.exports = {
    listPayouts,
    getPayout,
    rejectPayout,
    settlePayout,
};
