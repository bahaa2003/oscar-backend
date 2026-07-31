'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const validate = require('../../shared/middlewares/validate');
const referralController = require('./referral.controller');
const {
    dashboardValidation,
    commissionListValidation,
    inviteeListValidation,
    payoutListValidation,
    createPayoutValidation,
    payoutIdParamValidation,
} = require('./referral.validation');

const router = Router();

router.use(authenticate, requireActiveUser);

router.get('/me/dashboard', dashboardValidation, validate, referralController.getMyDashboard);
router.get('/me/commissions', commissionListValidation, validate, referralController.listMyCommissions);
router.get('/me/invitees', inviteeListValidation, validate, referralController.listMyInvitees);
router.post('/me/payouts', createPayoutValidation, validate, referralController.createMyPayout);
router.get('/me/payouts', payoutListValidation, validate, referralController.listMyPayouts);
router.get('/me/payouts/:id', payoutIdParamValidation, validate, referralController.getMyPayout);

module.exports = router;
