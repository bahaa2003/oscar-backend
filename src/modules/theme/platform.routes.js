'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { requirePaymentProvider } = require('./payment.provider');
const { ThemePayment, ThemeSubscription } = require('./subscription.model');
const manualPayment = require('./manualPayment.service');
const { createUpload, validateUploadedFileSignature } = require('../../shared/middlewares/upload');
const { AppError, BusinessRuleError } = require('../../shared/errors/AppError');
const fs = require('fs/promises');
const sharp = require('sharp');
const service = require('./theme.service');

const router = Router();
router.use(authenticate, authorize('ADMIN'));
const publishLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8',
    legacyHeaders: false, message: { success: false, code: 'THEME_RATE_LIMIT', message: 'Too many theme publishes.' } });
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5,
    keyGenerator: (req) => req.user._id.toString() });
const mediaLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });
const redeemLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8',
    legacyHeaders: false, keyGenerator: (req) => req.user._id.toString(),
    message: { success: false, code: 'CODE_RATE_LIMIT', message: 'Too many code attempts.' } });
const paymentReviewerIds = () => new Set(String(process.env.THEME_PAYMENT_REVIEWER_IDS || '')
    .split(',').map((value) => value.trim()).filter((value) => /^[a-f\d]{24}$/i.test(value)));
const requirePaymentReviewer = (req, _res, next) => {
    const reviewers = paymentReviewerIds();
    // Tests intentionally run without deployment configuration. Every real
    // environment fails closed until the payment owner is explicitly named.
    if (reviewers.size === 0 && process.env.NODE_ENV === 'test') return next();
    if (reviewers.size === 0) throw new AppError('Theme payment reviewer is not configured.', 503, 'THEME_PAYMENT_REVIEWER_MISSING');
    if (!reviewers.has(req.user._id.toString())) {
        throw new AppError('Only the configured theme payment reviewer can confirm transfers.', 403, 'THEME_PAYMENT_REVIEW_FORBIDDEN');
    }
    return next();
};

router.get('/settings', catchAsync(async (_req, res) => sendSuccess(res, await service.settings())));
router.get('/presets', (_req, res) => sendSuccess(res, { presets: service.presets(), allowed: service.allowed }));
router.post('/preview/validate', catchAsync(async (req, res) => sendSuccess(res,
    { configuration: service.validateTheme(req.body) }, 'Theme is valid')));
router.post('/draft', catchAsync(async (req, res) => sendSuccess(res,
    await service.saveDraft(req.user._id, req.body), 'Draft saved')));
router.post('/draft/reset', catchAsync(async (_req, res) => sendSuccess(res,
    await service.resetDraft(), 'Draft reset')));
router.post('/publish', publishLimit, catchAsync(async (req, res) => sendSuccess(res,
    await service.publish(req.user._id, req.body), 'Theme published')));
router.post('/restore', publishLimit, catchAsync(async (req, res) => sendSuccess(res,
    await service.restore(req.user._id, req.body?.version), 'Theme restored')));
router.get('/history', catchAsync(async (req, res) => sendSuccess(res,
    await service.history(Number(req.query.page || 1)))));
router.get('/entitlement', catchAsync(async (_req, res) => {
    const state = await service.getStatus();
    return sendSuccess(res, { eligibility: state.eligibility, plan: service.plan, checkoutAvailable: false });
}));
router.get('/subscription', catchAsync(async (_req, res) => {
    const state = await service.getStatus();
    return sendSuccess(res, { eligibility: state.eligibility, plan: service.plan,
        plans: service.plans, checkoutAvailable: false, manualPayment: manualPayment.instructions() });
}));
router.get('/subscription/payment-status', catchAsync(async (req, res) => {
    const items = await ThemePayment.find({ scopeKey: service.SCOPE_KEY, payerUserId: req.user._id })
        .select('provider providerReference planId isUpgrade amountMinor currency status verifiedAt createdAt updatedAt settlementCurrency settlementAmount network destination activationDeliveryStatus activationDeliveryAt')
        .sort({ createdAt: -1 }).limit(20).lean();
    const subscriptions = await ThemeSubscription.find({ verifiedPaymentId: { $in: items.map((item) => item._id) } })
        .select('verifiedPaymentId').lean();
    const redeemed = new Set(subscriptions.map((item) => String(item.verifiedPaymentId)));
    return sendSuccess(res, { items: items.map((item) => ({ ...item, redeemed: redeemed.has(String(item._id)) })) });
}));
router.post('/subscription/manual-order', checkoutLimit, catchAsync(async (req, res) => sendSuccess(res,
    await manualPayment.createOrder(req.user._id, req.body?.network, req.body?.planId), 'Manual USDT order created')));
router.get('/subscription/review-queue', requirePaymentReviewer, catchAsync(async (_req, res) => sendSuccess(res,
    { items: await manualPayment.reviewQueue() }, 'Theme payment review queue')));
// The logged-in platform administrator enters the transaction ID only after
// independently checking the transfer. Recipient details and the code remain
// server-side and are never accepted from, or returned to, the browser.
router.post('/subscription/manual-order/confirm', requirePaymentReviewer, catchAsync(async (req, res) => sendSuccess(res,
    await manualPayment.confirmAndNotify({ reference: req.body?.reference,
        chainTransactionId: req.body?.chainTransactionId, reviewer: req.user._id.toString() }),
    'Payment confirmed and activation code delivery attempted')));
router.post('/subscription/manual-order/reissue-code', requirePaymentReviewer, catchAsync(async (req, res) => sendSuccess(res,
    await manualPayment.reissueAndNotify({ reference: req.body?.reference, reviewer: req.user._id.toString() }),
    'Activation code delivery attempted')));
router.post('/subscription/redeem', redeemLimit, catchAsync(async (req, res) => sendSuccess(res,
    await manualPayment.redeemCode(req.user._id, req.body?.reference, req.body?.code), 'Theme Pro activated')));
router.post('/media/upload', mediaLimit, catchAsync(async (_req, _res, next) => {
    const state = await service.getStatus();
    if (!['THEME_PRO', 'THEME_ULTRA'].includes(state.eligibility.plan)) throw new AppError('Theme Pro or Ultra is required for brand images.', 403, 'THEME_PRO_REQUIRED');
    next();
}), (req, res, next) => {
    createUpload('themes').single('image')(req, res, async (error) => {
        if (error) return next(error);
        if (!req.file) return next(new BusinessRuleError('An image is required.', 'MISSING_FILE'));
        try {
            await validateUploadedFileSignature(req.file);
            const metadata = await sharp(req.file.path).metadata();
            if (req.file.size > 5 * 1024 * 1024 || !metadata.width || !metadata.height
                || metadata.width < 128 || metadata.height < 128
                || metadata.width > 6000 || metadata.height > 6000) {
                throw new BusinessRuleError('Image must be 128–6000 pixels and at most 5 MB.', 'INVALID_THEME_IMAGE');
            }
            return sendSuccess(res, { path: `/uploads/themes/${req.file.filename}` }, 'Theme image uploaded');
        } catch (validationError) {
            await fs.unlink(req.file.path).catch(() => undefined);
            return next(validationError);
        }
    });
});
router.post('/subscription/checkout', checkoutLimit, catchAsync(async (_req, _res) => {
    requirePaymentProvider();
}));

module.exports = router;
