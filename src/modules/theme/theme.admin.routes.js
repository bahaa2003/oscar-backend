'use strict';

const { Router } = require('express');
const mongoose = require('mongoose');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const { User } = require('../users/user.model');
const { ThemeSettings, ThemeHistory } = require('./theme.model');
const { ThemeSubscription, ThemePayment } = require('./subscription.model');
const ThemeAdminAudit = require('./theme.admin.model');

const router = Router();
router.use(authenticate, authorize('ADMIN'));
const objectId = (value) => {
    if (!mongoose.isValidObjectId(value)) throw new ValidationError('Invalid user ID');
    return value;
};
const pageOf = (value) => {
    const page = Number(value || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ValidationError('Invalid page');
    return page;
};

router.get('/subscribers', catchAsync(async (req, res) => {
    const page = pageOf(req.query.page);
    const now = new Date();
    const rows = await ThemeSubscription.find({ status: 'ACTIVE', expiresAt: { $gt: now }, startsAt: { $lte: now } })
        .sort({ expiresAt: 1 }).skip((page - 1) * 20).limit(20).populate('userId', 'name email').lean();
    return sendSuccess(res, { items: rows, page });
}));

router.get('/users', catchAsync(async (req, res) => {
    const term = String(req.query.search || '').trim();
    if (term.length < 2 || term.length > 100) throw new ValidationError('Search must be 2-100 characters');
    const escaped = term.replace(/[^\p{L}\p{N}]/gu, '\\$&');
    const users = await User.find({ $or: [{ name: new RegExp(escaped, 'i') },
        { email: new RegExp(escaped, 'i') }] }).select('name email role').limit(20).lean();
    return sendSuccess(res, { items: users });
}));

router.get('/payments/failed', catchAsync(async (req, res) => {
    const page = pageOf(req.query.page);
    const rows = await ThemePayment.find({ status: { $in: ['FAILED', 'CHARGEBACK', 'REFUNDED'] } })
        .sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).lean();
    return sendSuccess(res, { items: rows, page });
}));

router.get('/users/:userId', catchAsync(async (req, res) => {
    const userId = objectId(req.params.userId);
    const user = await User.findById(userId).select('name email role').lean();
    if (!user) throw new NotFoundError('User');
    const [settings, subscriptions, payments, history, audit] = await Promise.all([
        ThemeSettings.findOne({ userId }).select('version customizationDisabled lastSuccessfulPublishAt createdAt updatedAt').lean(),
        ThemeSubscription.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
        ThemePayment.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
        ThemeHistory.find({ userId }).sort({ version: -1 }).limit(20).lean(),
        ThemeAdminAudit.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    const now = new Date();
    return sendSuccess(res, { user, settings, subscriptions: subscriptions.map((subscription) => ({
        ...subscription,
        effectiveStatus: subscription.status === 'ACTIVE' && subscription.startsAt <= now && subscription.expiresAt > now
            ? 'ACTIVE' : subscription.status === 'ACTIVE' ? 'EXPIRED' : subscription.status,
    })), payments, history, audit });
}));

router.patch('/users/:userId/availability', catchAsync(async (req, res) => {
    const userId = objectId(req.params.userId);
    const { disabled, reason } = req.body || {};
    if (typeof disabled !== 'boolean' || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500)
        throw new ValidationError('disabled must be a boolean and reason must be 1-500 characters');
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            const user = await User.findById(userId).session(session);
            if (!user) throw new NotFoundError('User');
            const settings = await ThemeSettings.findOneAndUpdate({ userId },
                { $set: { customizationDisabled: disabled }, $setOnInsert: { userId } },
                { upsert: true, new: true, session });
            await ThemeAdminAudit.create([{ userId, actorId: req.user._id,
                action: disabled ? 'DISABLE' : 'ENABLE', reason: reason.trim() }], { session });
            result = { userId, disabled: settings.customizationDisabled };
        });
    } finally { await session.endSession(); }
    return sendSuccess(res, result, 'Theme availability updated');
}));

module.exports = router;
