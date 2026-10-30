'use strict';

const mongoose = require('mongoose');
const { ThemeSettings, ThemeHistory } = require('./theme.model');
const { ThemeSubscription, ThemePayment } = require('./subscription.model');
const { validateTheme, safeTheme, preset, allowed, assertPlanAllows, FREE_PRESETS, PRO_PRESETS } = require('./theme.validation');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const SCOPE_KEY = 'main';
const plans = Object.freeze({
    THEME_PRO: { id: 'THEME_PRO', name: 'Theme Customization Pro', amountMinor: 2499, currency: 'USDT', durationCalendarMonths: 3, recurring: false },
    THEME_ULTRA: { id: 'THEME_ULTRA', name: 'Theme Customization Ultra', amountMinor: 2999, currency: 'USDT', durationCalendarMonths: 3, recurring: false, limitedOfferUsd: 70 },
});
const plan = plans.THEME_PRO;

function addCalendarMonthsUTC(start, months = 3) {
    const date = new Date(start);
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
        date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target;
}

async function currentSubscription(now = new Date(), session = null) {
    const subscription = await ThemeSubscription.findOne({ scopeKey: SCOPE_KEY, planId: { $in: Object.keys(plans) }, amountMinor: { $in: [500, 2499, 2999] },
        currency: { $in: ['USD', 'USDT'] }, status: 'ACTIVE', startsAt: { $lte: now }, expiresAt: { $gt: now } })
        .sort({ planId: -1, expiresAt: -1 }).session(session).lean();
    if (!subscription) return null;
    const payment = await ThemePayment.findOne({ _id: subscription.verifiedPaymentId, scopeKey: SCOPE_KEY,
        payerUserId: subscription.payerUserId,
        amountMinor: subscription.amountMinor, currency: subscription.currency, status: 'VERIFIED', verifiedAt: { $lte: now } })
        .session(session).select('verifiedAt planId isUpgrade upgradedFromSubscriptionId').lean();
    const duration = subscription.durationCalendarMonths ?? 3;
    if (!payment || ![3, 10].includes(duration)
        || (payment.planId && payment.planId !== subscription.planId)
        || new Date(subscription.startsAt).getTime() < new Date(payment.verifiedAt).getTime()) return null;
    if (subscription.amountMinor === 500) {
        if (subscription.planId !== 'THEME_ULTRA' || !payment.isUpgrade || !subscription.upgradedFromSubscriptionId
            || String(payment.upgradedFromSubscriptionId) !== String(subscription.upgradedFromSubscriptionId)) return null;
        const previous = await ThemeSubscription.findOne({ _id: subscription.upgradedFromSubscriptionId,
            scopeKey: SCOPE_KEY, planId: 'THEME_PRO' }).session(session).lean();
        if (!previous || new Date(previous.expiresAt).getTime() !== new Date(subscription.expiresAt).getTime()) return null;
    } else if (new Date(subscription.expiresAt).getTime() !== addCalendarMonthsUTC(subscription.startsAt, duration).getTime()) return null;
    return subscription;
}

const freeHistoryQuery = { scopeKey: SCOPE_KEY, $or: [{ planId: 'FREE' }, { planId: { $exists: false } }] };

function eligibility(settings, subscription, now = new Date(), freeChangesUsed = 0) {
    const last = settings?.lastSuccessfulPublishAt || null;
    const nextFreeEditAt = last ? new Date(new Date(last).getTime() + COOLDOWN_MS) : null;
    const paid = Boolean(subscription);
    return {
        plan: paid ? subscription.planId : 'FREE',
        canPublish: paid || (freeChangesUsed < 2 && (!nextFreeEditAt || now >= nextFreeEditAt)),
        freeChangesUsed,
        freeChangesRemaining: Math.max(0, 2 - freeChangesUsed),
        lastSuccessfulPublishAt: last,
        nextFreeEditAt,
        remainingMs: paid || !nextFreeEditAt ? 0 : Math.max(0, nextFreeEditAt.getTime() - now.getTime()),
        subscription: subscription ? { startsAt: subscription.startsAt, expiresAt: subscription.expiresAt,
            daysRemaining: Math.ceil((new Date(subscription.expiresAt).getTime() - now.getTime()) / 86400000) } : null,
    };
}

async function getStatus() {
    const now = new Date();
    const [settings, subscription, freeChangesUsed] = await Promise.all([
        ThemeSettings.findOne({ scopeKey: SCOPE_KEY }).lean(), currentSubscription(now),
        ThemeHistory.countDocuments(freeHistoryQuery),
    ]);
    return { settings, eligibility: eligibility(settings, subscription, now, freeChangesUsed) };
}

async function settings() {
    const state = await getStatus();
    return { published: safeTheme(state.settings?.published), draft: state.settings?.draft ? safeTheme(state.settings.draft) : null,
        version: state.settings?.version || 0, eligibility: state.eligibility, plan, plans };
}

async function published() {
    const record = await ThemeSettings.findOne({ scopeKey: SCOPE_KEY }).select('published version updatedAt').lean();
    return { published: record?.published ? safeTheme(record.published) : null,
        version: record?.version || 0, updatedAt: record?.updatedAt || null };
}

async function saveDraft(_actorId, value) {
    const theme = validateTheme(value);
    const record = await ThemeSettings.findOneAndUpdate({ scopeKey: SCOPE_KEY },
        { $set: { draft: theme }, $setOnInsert: { scopeKey: SCOPE_KEY } }, { upsert: true, new: true, runValidators: true });
    return { draft: safeTheme(record.draft) };
}

async function resetDraft() {
    await ThemeSettings.updateOne({ scopeKey: SCOPE_KEY }, { $set: { draft: null } });
    return { draft: null };
}

async function publish(actorId, value, operation = 'PUBLISH') {
    const theme = validateTheme(value);
    for (let attempt = 0; attempt < 4; attempt++) {
        const session = await mongoose.startSession();
        try {
            let result;
            await session.withTransaction(async () => {
                // One platform document serializes every administrator's publishes.
                const record = await ThemeSettings.findOneAndUpdate({ scopeKey: SCOPE_KEY },
                    { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: SCOPE_KEY } },
                    { upsert: true, new: true, session });
                const now = new Date();
                const subscription = await currentSubscription(now, session);
                const freeChangesUsed = await ThemeHistory.countDocuments(freeHistoryQuery).session(session);
                const access = eligibility(record, subscription, now, freeChangesUsed);
                assertPlanAllows(theme, subscription?.planId || 'FREE');
                if (!subscription) {
                    if (freeChangesUsed >= 2) {
                        throw new AppError('The free plan allows two theme changes. Subscribe to PRO or ULTRA for more.', 403, 'THEME_FREE_LIMIT');
                    }
                }
                if (!access.canPublish) {
                    const error = new AppError('The next free publish is not available yet.', 429, 'THEME_COOLDOWN');
                    error.errors = [{ field: 'nextFreeEditAt', value: access.nextFreeEditAt }];
                    throw error;
                }
                const version = record.version + 1;
                await ThemeSettings.updateOne({ _id: record._id },
                    { $set: { published: theme, draft: null, lastSuccessfulPublishAt: now, version } }, { session });
                await ThemeHistory.create([{ scopeKey: SCOPE_KEY, actorId, configuration: theme, version,
                    operation, planId: subscription?.planId || 'FREE', publishedAt: now }], { session });
                result = { published: theme, version, publishedAt: now, eligibility: eligibility({
                    ...record.toObject(), lastSuccessfulPublishAt: now }, subscription, now, freeChangesUsed + (subscription ? 0 : 1)) };
            });
            return result;
        } catch (error) {
            if (attempt < 3 && (error.hasErrorLabel?.('TransientTransactionError') || error.code === 11000)) continue;
            throw error;
        } finally { await session.endSession(); }
    }
}

async function restore(actorId, version) {
    if (!Number.isSafeInteger(version) || version < 1) throw new NotFoundError('Theme version');
    const record = await ThemeHistory.findOne({ scopeKey: SCOPE_KEY, version }).lean();
    if (!record) throw new NotFoundError('Theme version');
    return publish(actorId, record.configuration, 'RESTORE');
}

async function history(page = 1) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10000) : 1;
    const rows = await ThemeHistory.find({ scopeKey: SCOPE_KEY }).sort({ version: -1 }).skip((safePage - 1) * 20).limit(20).lean();
    return { items: rows, page: safePage };
}

function presets() {
    return [...FREE_PRESETS.map((id) => ({ id, tier: 'FREE', configuration: preset(id) })),
        ...PRO_PRESETS.map((id) => ({ id, tier: 'THEME_PRO', configuration: preset(id) }))];
}

module.exports = { settings, published, getStatus, saveDraft, resetDraft, publish, restore, history, presets,
    validateTheme, eligibility, currentSubscription, addCalendarMonthsUTC, plan, plans, allowed, SCOPE_KEY };
