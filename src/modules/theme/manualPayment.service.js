'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { User } = require('../users/user.model');
const { ThemePayment, ThemeSubscription, ThemeActivationCode, ThemeCodeUse } = require('./subscription.model');
const { ThemeSettings } = require('./theme.model');
const themeService = require('./theme.service');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const whatsappService = require('../whatsapp/whatsapp.service');

const offers = Object.freeze({
    THEME_PRO: { id: 'THEME_PRO', amount: '24.99', amountMinor: 2499, name: 'Theme Customization Pro', durationCalendarMonths: 3 },
    THEME_ULTRA: { id: 'THEME_ULTRA', amount: '29.99', amountMinor: 2999, name: 'Theme Customization Ultra', durationCalendarMonths: 3, originalUsd: 70 },
});
const amount = offers.THEME_PRO.amount;
const chargeFor = (offer, isUpgrade = false) => isUpgrade && offer.id === 'THEME_ULTRA'
    ? { ...offer, amount: '5.00', amountMinor: 500, isUpgrade: true } : { ...offer, isUpgrade: false };
const whatsapp = String(process.env.THEME_PAYMENT_WHATSAPP || '').replace(/[^\d]/g, '');
const destinations = Object.freeze({
    BINANCE_ID: String(process.env.THEME_PAYMENT_BINANCE_ID || '').trim(),
    TRC20: String(process.env.THEME_PAYMENT_TRC20_ADDRESS || '').trim(),
    BEP20: String(process.env.THEME_PAYMENT_BEP20_ADDRESS || '').trim(),
});
const payeeName = String(process.env.THEME_PAYMENT_PAYEE_NAME || '').trim();
const isPaymentConfigured = () => Boolean(whatsapp && payeeName && Object.values(destinations).some(Boolean));
const requirePaymentConfig = (network) => {
    if (!whatsapp || !payeeName || !destinations[network]) {
        throw new AppError('Manual theme payment is not configured for this network.', 503, 'THEME_PAYMENT_CONFIG_MISSING');
    }
};
const CODE_LIFETIME_MS = 48 * 60 * 60 * 1000;
const makeCode = () => String(crypto.randomInt(0, 10_000_000_000)).padStart(10, '0');
const hashCode = (code, salt) => crypto.scryptSync(code, salt, 32).toString('hex');
const fingerprintCode = (code) => {
    const secret = process.env.THEME_CODE_PEPPER || process.env.JWT_SECRET;
    if (!secret) throw new AppError('The activation-code secret is not configured.', 503, 'CODE_SECRET_MISSING');
    return crypto.createHmac('sha256', secret).update(`platform-theme:${code}`).digest('hex');
};
const validReference = (reference) => /^THEME-[0-9A-F-]{36}$/.test(reference || '');
const validReviewer = (reviewer) => /^[A-Za-z0-9 ._-]{3,80}$/.test(reviewer || '');

const activationMessage = ({ reference, code, offer = offers.THEME_PRO, isUpgrade = false }) => `أهلًا بحضرتك مع شركه DIGI TECH المصريه❤️
تم تأكيد الدفع بنجاح، وده كود تفعيل ${isUpgrade ? 'الترقية إلى' : 'اشتراك'} ${offer.name} ${isUpgrade ? 'حتى نهاية مدة اشتراكك الحالي' : 'لمدة 3 شهور'}:
🔑 كود التفعيل: ${code}
📌 مرجع الطلب: ${reference}
⏳ الكود صالح لمدة 48 ساعة من وقت إصداره، ويُستخدم مرة واحدة فقط.
يرجى تسجيل الدخول إلى حساب الإدارة من لوحه الادمن توجه الي الثيمات وإدخل كود التفعيل في صفحة الاشتراك لإتمام التفعيل.`;

const safeDeliveryError = (error) => String(error?.message || 'WhatsApp delivery failed.')
    .replace(/[\r\n]+/g, ' ').slice(0, 300);

async function deliverActivationCode({ paymentId, payerPhone, reference, code, offer, isUpgrade }) {
    try {
        const outcome = await whatsappService.sendWhatsAppMessage(payerPhone, activationMessage({ reference, code, offer, isUpgrade }));
        const deliveryStatus = outcome?.deliveryStatus === 'SKIPPED' ? 'SKIPPED' : 'SENT';
        await ThemePayment.updateOne({ _id: paymentId, status: 'VERIFIED' }, {
            $set: { activationDeliveryStatus: deliveryStatus, activationDeliveryAt: new Date(), activationDeliveryError: undefined },
        });
        return { status: deliveryStatus };
    } catch (error) {
        await ThemePayment.updateOne({ _id: paymentId, status: 'VERIFIED' }, {
            $set: { activationDeliveryStatus: 'FAILED', activationDeliveryError: safeDeliveryError(error) },
            $unset: { activationDeliveryAt: 1 },
        });
        // Keep operational logs useful without recording the activation code,
        // phone number, or raw WhatsApp error payload.
        console.warn(`[ThemeSubscription] Activation-code WhatsApp delivery failed for ${reference}.`);
        return { status: 'FAILED' };
    }
}

const instructions = () => ({ offers: Object.values(offers).map((offer) => ({ ...offer, currency: 'USDT', recurring: false })),
    amount, currency: 'USDT', amountMinor: 2499, durationCalendarMonths: 3, recurring: false,
    available: isPaymentConfigured(), whatsapp: whatsapp || null, payeeName: payeeName || null,
    destinations: Object.fromEntries(Object.entries(destinations).filter(([, destination]) => Boolean(destination))),
    activationCodeHours: 48,
    proof: 'Send the transfer screenshot and order reference in WhatsApp. After receipt is verified, the server sends a one-time 10-digit code to the payer WhatsApp number; it is valid for 48 hours.' });

async function createOrder(payerUserId, network, planId = 'THEME_PRO') {
    if (!Object.hasOwn(destinations, network)) throw new ValidationError('Unsupported USDT transfer network.');
    requirePaymentConfig(network);
    const offer = Object.hasOwn(offers, planId) ? offers[planId] : null;
    if (!offer) throw new ValidationError('Unsupported theme subscription plan.');
    const status = await themeService.getStatus();
    const charge = chargeFor(offer, status.eligibility.plan === 'THEME_PRO' && offer.id === 'THEME_ULTRA');
    const upgradeSource = charge.isUpgrade ? await themeService.currentSubscription() : null;
    if (charge.isUpgrade && upgradeSource?.planId !== 'THEME_PRO') throw new AppError('An active PRO subscription is required for this upgrade.', 409, 'THEME_UPGRADE_UNAVAILABLE');
    if (['THEME_PRO', 'THEME_ULTRA'].includes(status.eligibility.plan) && !charge.isUpgrade) throw new AppError('A theme subscription is already active.', 409, 'THEME_PLAN_ACTIVE');
    const verified = await ThemePayment.findOne({ scopeKey: 'main', payerUserId, provider: 'MANUAL_USDT',
        status: 'VERIFIED' }).sort({ verifiedAt: -1 }).lean();
    if (verified && !(await ThemeSubscription.exists({ verifiedPaymentId: verified._id }))) {
        throw new AppError('A verified transfer is awaiting code redemption.', 409, 'THEME_CODE_PENDING');
    }
    let payment = await ThemePayment.findOne({ scopeKey: 'main', payerUserId, provider: 'MANUAL_USDT',
        network, ...(offer.id === 'THEME_PRO' ? { planId: { $in: [offer.id, null] } } : { planId: offer.id }),
        isUpgrade: charge.isUpgrade ? true : { $ne: true },
        ...(charge.isUpgrade ? { upgradedFromSubscriptionId: upgradeSource._id } : {}), status: 'PENDING', $or: [
            { durationCalendarMonths: 3 }, { durationCalendarMonths: { $exists: false } },
        ] }).sort({ createdAt: -1 }).lean();
    if (!payment) {
        payment = await ThemePayment.create({ scopeKey: 'main', payerUserId,
            provider: 'MANUAL_USDT', providerReference: `THEME-${crypto.randomUUID().toUpperCase()}`,
            planId: offer.id, isUpgrade: charge.isUpgrade, upgradedFromSubscriptionId: upgradeSource?._id,
            amountMinor: charge.amountMinor, currency: 'USDT', settlementCurrency: 'USDT', settlementAmount: charge.amount,
            network, destination: destinations[network], durationCalendarMonths: offer.durationCalendarMonths, status: 'PENDING' });
    }
    const message = `طلب ${charge.isUpgrade ? 'ترقية' : 'اشتراك'} ${offer.name}\n${payment.providerReference}\nالشبكة: ${network}\nالمبلغ: ${charge.amount} USDT صافي\nوجهة التحويل: ${destinations[network]}\nسأرفق صورة إثبات التحويل. أرجو تأكيد وصول المبلغ.`;
    return { paymentId: payment._id, reference: payment.providerReference, status: payment.status,
        planId: offer.id, planName: offer.name, isUpgrade: charge.isUpgrade, network, destination: destinations[network], amount: charge.amount, currency: 'USDT',
        expiresAt: upgradeSource?.expiresAt || null,
        durationCalendarMonths: payment.durationCalendarMonths ?? 3,
        whatsappUrl: `https://wa.me/${whatsapp}?text=${encodeURIComponent(message)}` };
}

async function reviewQueue() {
    const payments = await ThemePayment.find({ scopeKey: 'main', provider: 'MANUAL_USDT', $or: [
        { status: 'PENDING' },
        { status: 'VERIFIED', activationDeliveryStatus: 'FAILED' },
    ] }).select('payerUserId providerReference planId isUpgrade amountMinor currency settlementAmount settlementCurrency network destination status activationDeliveryStatus createdAt')
        .sort({ createdAt: 1 }).limit(50).lean();
    const users = await User.find({ _id: { $in: payments.map((payment) => payment.payerUserId) } })
        .select('name email').lean();
    const usersById = new Map(users.map((user) => [String(user._id), { name: user.name, email: user.email }]));
    return payments.map((payment) => ({
        ...payment,
        payer: usersById.get(String(payment.payerUserId)) || null,
        deliveryError: payment.activationDeliveryStatus === 'FAILED'
            ? 'WhatsApp delivery failed. Check the connected session and the customer phone number.' : null,
    }));
}

// This function records only a payment the operator has independently verified
// in the developer's receiving account. The HTTP route below it never accepts a
// customer phone number or an activation code.
async function confirmReceived({ reference, network, chainTransactionId, reviewer, receivedAmount, activationCode, planId = 'THEME_PRO', isUpgrade = false }) {
    const offer = Object.hasOwn(offers, planId) ? offers[planId] : null;
    const charge = offer && chargeFor(offer, isUpgrade);
    if (!validReference(reference) || !Object.hasOwn(destinations, network)
        || !/^[A-Za-z0-9:_-]{8,128}$/.test(chainTransactionId || '')
        || !validReviewer(reviewer) || !charge || receivedAmount !== charge.amount
        || (activationCode !== undefined && !/^\d{10}$/.test(activationCode))) {
        throw new ValidationError('Valid order, network, transaction ID, reviewer and the exact plan amount received are required.');
    }
    const code = activationCode ?? makeCode();
    const codeFingerprint = fingerprintCode(code);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } },
                { upsert: true, session });
            const payment = await ThemePayment.findOne({ provider: 'MANUAL_USDT', providerReference: reference,
                scopeKey: 'main', ...(offer.id === 'THEME_PRO' ? { $or: [{ planId: offer.id }, { planId: { $exists: false } }] } : { planId: offer.id }),
                isUpgrade: charge.isUpgrade ? true : { $ne: true }, network, destination: destinations[network], status: 'PENDING',
                amountMinor: charge.amountMinor, currency: 'USDT', settlementCurrency: 'USDT', settlementAmount: charge.amount }).session(session);
            if (!payment) throw new AppError('Pending payment order was not found.', 409, 'PAYMENT_NOT_PENDING');
            const payer = await User.findById(payment.payerUserId).session(session).select('role status phone').lean();
            if (payer?.role !== 'ADMIN' || payer?.status !== 'ACTIVE') throw new AppError('The payer is not an active platform administrator.', 403, 'INVALID_PAYER');
            const now = new Date();
            const alreadyActive = await themeService.currentSubscription(now, session);
            if (charge.isUpgrade && (alreadyActive?.planId !== 'THEME_PRO'
                || String(alreadyActive._id) !== String(payment.upgradedFromSubscriptionId))) {
                throw new AppError('The original PRO subscription must still be active for this upgrade.', 409, 'THEME_UPGRADE_UNAVAILABLE');
            }
            if (alreadyActive && !(charge.isUpgrade && alreadyActive.planId === 'THEME_PRO')) throw new AppError('A theme subscription is already active.', 409, 'THEME_PLAN_ACTIVE');
            payment.status = 'VERIFIED';
            payment.verifiedAt = now;
            payment.chainTransactionId = chainTransactionId;
            payment.verifiedBy = reviewer;
            payment.activationDeliveryStatus = 'PENDING';
            payment.activationDeliveryAt = null;
            payment.activationDeliveryError = undefined;
            await payment.save({ session });
            const salt = crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS);
            await ThemeCodeUse.create([{ scopeKey: 'main', paymentId: payment._id,
                codeFingerprint, issuedAt: now }], { session });
            await ThemeActivationCode.create([{ scopeKey: 'main', paymentId: payment._id,
                payerUserId: payer._id, salt, codeHash: hashCode(code, salt), expiresAt, issuedBy: reviewer }], { session });
            result = { paymentId: payment._id, payerPhone: payer.phone, reference, code, codeExpiresAt: expiresAt, offer, isUpgrade: payment.isUpgrade };
        });
        return result;
    } catch (error) {
        if (error.code === 11000 && error.keyPattern?.codeFingerprint) {
            throw new AppError('This activation code has already been assigned.', 409, 'CODE_ALREADY_ASSIGNED');
        }
        throw error;
    } finally { await session.endSession(); }
}

// Used by the live server only after an administrator manually confirms the
// transfer. It deliberately returns no plaintext activation code.
async function confirmAndNotify({ reference, chainTransactionId, reviewer }) {
    if (!validReference(reference) || !/^[A-Za-z0-9:_-]{8,128}$/.test(chainTransactionId || '') || !validReviewer(reviewer)) {
        throw new ValidationError('A valid order reference and transaction ID are required.');
    }
    const payment = await ThemePayment.findOne({ scopeKey: 'main', provider: 'MANUAL_USDT',
        providerReference: reference, status: 'PENDING' }).select('network planId isUpgrade').lean();
    if (!payment?.network) throw new AppError('Pending payment order was not found.', 409, 'PAYMENT_NOT_PENDING');
    const issued = await confirmReceived({ reference, network: payment.network, chainTransactionId,
        reviewer, planId: payment.planId || 'THEME_PRO', isUpgrade: payment.isUpgrade === true,
        receivedAmount: chargeFor(offers[payment.planId || 'THEME_PRO'], payment.isUpgrade === true).amount });
    const delivery = await deliverActivationCode(issued);
    return { reference: issued.reference, codeExpiresAt: issued.codeExpiresAt, deliveryStatus: delivery.status };
}

// Operator-only recovery when a verified payer's code expired or was lost.
async function reissueCode({ reference, reviewer, activationCode }) {
    if (!validReference(reference) || !validReviewer(reviewer)
        || (activationCode !== undefined && !/^\d{10}$/.test(activationCode))) {
        throw new ValidationError('A valid reference, reviewer, and optional 10-digit code are required.');
    }
    const code = activationCode ?? makeCode();
    const codeFingerprint = fingerprintCode(code);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } }, { upsert: true, session });
            const payment = await ThemePayment.findOne({ scopeKey: 'main', provider: 'MANUAL_USDT',
                providerReference: reference, status: 'VERIFIED', currency: 'USDT' }).session(session);
            if (!payment) throw new AppError('Verified payment was not found.', 404, 'PAYMENT_NOT_VERIFIED');
            if (await ThemeSubscription.exists({ verifiedPaymentId: payment._id }).session(session)) {
                throw new AppError('This payment has already been redeemed.', 409, 'PAYMENT_REDEEMED');
            }
            const salt = crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
            await ThemeCodeUse.create([{ scopeKey: 'main', paymentId: payment._id,
                codeFingerprint, issuedAt: new Date() }], { session });
            const record = await ThemeActivationCode.findOneAndUpdate({ paymentId: payment._id, redeemedAt: null },
                { $set: { salt, codeHash: hashCode(code, salt), expiresAt, issuedBy: reviewer },
                    $inc: { issueCount: 1 } }, { new: true, session });
            if (!record) throw new AppError('Unredeemed activation code was not found.', 409, 'CODE_NOT_REISSUABLE');
            const payer = await User.findById(payment.payerUserId).session(session).select('phone').lean();
            payment.activationDeliveryStatus = 'PENDING';
            payment.activationDeliveryAt = null;
            payment.activationDeliveryError = undefined;
            await payment.save({ session });
            result = { paymentId: payment._id, payerPhone: payer?.phone, reference, code, codeExpiresAt: expiresAt,
                offer: offers[payment.planId || 'THEME_PRO'], isUpgrade: payment.isUpgrade };
        });
        return result;
    } catch (error) {
        if (error.code === 11000 && error.keyPattern?.codeFingerprint) {
            throw new AppError('This activation code has already been assigned.', 409, 'CODE_ALREADY_ASSIGNED');
        }
        throw error;
    } finally { await session.endSession(); }
}

async function reissueAndNotify({ reference, reviewer }) {
    const issued = await reissueCode({ reference, reviewer });
    const delivery = await deliverActivationCode(issued);
    return { reference: issued.reference, codeExpiresAt: issued.codeExpiresAt, deliveryStatus: delivery.status };
}

async function redeemCode(payerUserId, reference, code) {
    if (!validReference(reference) || !/^\d{10}$/.test(code || '')) {
        throw new ValidationError('Order reference and 10-digit activation code are required.');
    }
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } }, { upsert: true, session });
            const payer = await User.findById(payerUserId).session(session).select('role status').lean();
            if (payer?.role !== 'ADMIN' || payer?.status !== 'ACTIVE') throw new AppError('Only an active administrator can redeem a code.', 403, 'INVALID_PAYER');
            const payment = await ThemePayment.findOne({ scopeKey: 'main', payerUserId,
                provider: 'MANUAL_USDT', providerReference: reference, status: 'VERIFIED', currency: 'USDT' }).session(session);
            if (!payment) throw new AppError('Verified payment was not found.', 404, 'PAYMENT_NOT_VERIFIED');
            const activation = await ThemeActivationCode.findOne({ paymentId: payment._id, payerUserId }).session(session);
            if (!activation || activation.redeemedAt) throw new AppError('Activation code is unavailable.', 409, 'CODE_UNAVAILABLE');
            const now = new Date();
            if (activation.expiresAt <= now) throw new AppError('Activation code expired. Request a new code.', 410, 'CODE_EXPIRED');
            const submitted = Buffer.from(hashCode(code, activation.salt), 'hex');
            if (!crypto.timingSafeEqual(submitted, Buffer.from(activation.codeHash, 'hex'))) {
                throw new AppError('Activation code is incorrect.', 400, 'CODE_INVALID');
            }
            const activeSubscription = await themeService.currentSubscription(now, session);
            if (payment.isUpgrade && (payment.planId !== 'THEME_ULTRA' || activeSubscription?.planId !== 'THEME_PRO'
                || String(activeSubscription._id) !== String(payment.upgradedFromSubscriptionId))) {
                throw new AppError('The original PRO subscription must still be active for this upgrade.', 409, 'THEME_UPGRADE_UNAVAILABLE');
            }
            if (activeSubscription && !payment.isUpgrade) {
                throw new AppError('A theme subscription is already active.', 409, 'THEME_PLAN_ACTIVE');
            }
            const subscription = await ThemeSubscription.create([{ scopeKey: 'main', payerUserId,
                planId: payment.planId || 'THEME_PRO', amountMinor: payment.amountMinor, currency: 'USDT', status: 'ACTIVE',
                durationCalendarMonths: payment.durationCalendarMonths ?? 3,
                upgradedFromSubscriptionId: payment.isUpgrade ? activeSubscription._id : null,
                verifiedPaymentId: payment._id, startsAt: now,
                expiresAt: payment.isUpgrade ? activeSubscription.expiresAt : themeService.addCalendarMonthsUTC(now, payment.durationCalendarMonths ?? 3) }], { session });
            activation.redeemedAt = now;
            await activation.save({ session });
            result = { plan: subscription[0].planId, subscriptionId: subscription[0]._id, expiresAt: subscription[0].expiresAt };
        });
        return result;
    } finally { await session.endSession(); }
}

module.exports = { instructions, createOrder, confirmReceived, confirmAndNotify, reissueCode, reissueAndNotify,
    redeemCode, reviewQueue, destinations, offers, activationMessage };
