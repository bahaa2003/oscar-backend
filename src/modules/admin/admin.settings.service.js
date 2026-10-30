'use strict';

/**
 * admin.settings.service.js
 *
 * CRUD over the Setting collection.
 * Only admins can write. Reads can be used internally.
 */

const { Setting, DEFAULT_SETTINGS } = require('./setting.model');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const themeService = require('../theme/theme.service');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const settingsCache = require('./settings.cache');
const {
    validatePaymentGroupsFeePercent,
    validatePaymentGroupsQrCodeImages,
} = require('../deposits/paymentMethodFee');

const PAYMENT_SETTING_KEYS = new Set([
    'paymentGroups',
    'paymentCountryAccounts',
    'paymentInstructions',
    'whatsappNumber',
    'supportContacts',
    'adminNotificationWhatsApp',
]);

const normalizeSupportContacts = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid support contacts');
    const clean = (number) => String(number || '').trim()
        .replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 15))
        .replace(/[\s()-]/g, '');
    const owner = clean(value.owner);
    const support = clean(value.support);
    if (!/^\+[1-9][0-9]{7,14}$/.test(owner) || !/^\+[1-9][0-9]{7,14}$/.test(support)) {
        throw new ValidationError('Enter both WhatsApp numbers in international format, for example +201012345678.');
    }
    return { owner, support };
};
const normalizeInternationalWhatsApp = (value) => {
    const input = String(value || '').trim().replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 15));
    if (!input) return '';
    if (!/^(?:\+|00)[\d\s()-]+$/.test(input)) throw new ValidationError('Enter a valid WhatsApp number with country code.');
    let number = input.replace(/[^\d]/g, '');
    if (number.startsWith('00')) number = number.slice(2);
    if (!/^[1-9]\d{7,14}$/.test(number)) throw new ValidationError('Enter a valid WhatsApp number with country code, for example +201012345678.');
    return `+${number}`;
};

// ─── List ──────────────────────────────────────────────────────────────────────

const listSettings = async () => {
    return Setting.find().sort({ key: 1 }).select('-__v');
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getSettingByKey = async (key) => {
    const setting = await Setting.findOne({ key });
    if (!setting) throw new NotFoundError('Setting');
    return setting;
};

// ─── Get value (internal use) ─────────────────────────────────────────────────

const getSettingValue = async (key, defaultValue = null) => {
    const setting = await Setting.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

const getPaymentSettings = async () => {
    const cacheKey = settingsCache.SETTINGS_CACHE_KEYS.paymentGroups;
    const cached = settingsCache.get(cacheKey);
    if (cached) return cached;

    const keys = [...PAYMENT_SETTING_KEYS];
    const settings = await Setting.find({ key: { $in: keys } }).lean();
    const find = (key) => settings.find((s) => s.key === key)?.value;

    const paymentGroups = (find('paymentGroups') || [])
        .filter((g) => g.isActive !== false)
        .map((g) => ({
            ...g,
            methods: (g.methods || []).filter((m) => m.isActive !== false),
        }))
        .filter((g) => g.methods && g.methods.length > 0);

    const payload = {
        paymentGroups,
        countryAccounts: find('paymentCountryAccounts') || [],
        instructions: find('paymentInstructions') || '',
        whatsappNumber: find('whatsappNumber') || '',
        supportContacts: find('supportContacts') || null,
    };

    return settingsCache.set(cacheKey, payload);
};

const invalidateSettingsCache = (key) => {
    if (!key) {
        settingsCache.clear();
        return;
    }

    if (PAYMENT_SETTING_KEYS.has(key)) {
        settingsCache.del(settingsCache.SETTINGS_CACHE_KEYS.paymentGroups);
    }
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateSetting = async (key, value, adminId) => {
    let setting = await Setting.findOne({ key });
    // A payment setting can be absent when the startup seed has not completed.
    // An authenticated admin update should still be able to create that known key.
    if (!setting && !PAYMENT_SETTING_KEYS.has(key)) throw new NotFoundError('Setting');

    const before = setting?.value;

    if (key === 'paymentGroups') {
        validatePaymentGroupsFeePercent(value);
        validatePaymentGroupsQrCodeImages(value);
    }
    if (key === 'supportContacts' || key === 'adminNotificationWhatsApp') {
        const status = await themeService.getStatus();
        if (status.eligibility.plan !== 'THEME_ULTRA') {
            throw new AppError('Changing WhatsApp contact or notification numbers requires Theme Customization Ultra.', 403, 'THEME_ULTRA_REQUIRED');
        }
        value = key === 'supportContacts' ? normalizeSupportContacts(value) : normalizeInternationalWhatsApp(value);
    }

    if (setting) {
        // Mongoose does not detect mutations to Mixed-type fields.
        setting.value = value;
        setting.updatedBy = adminId;
        setting.markModified('value');
        await setting.save();
    } else {
        const description = DEFAULT_SETTINGS.find((item) => item.key === key)?.description || '';
        setting = await Setting.findOneAndUpdate(
            { key },
            { $set: { value, updatedBy: adminId }, $setOnInsert: { description } },
            { upsert: true, new: true, runValidators: true }
        );
    }

    invalidateSettingsCache(key);

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SETTING_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: key === 'adminNotificationWhatsApp'
            ? { key, before: before ? '[REDACTED]' : '', after: value ? '[REDACTED]' : '' }
            : { key, before, after: value },
    });

    return setting;
};

module.exports = {
    listSettings,
    getSettingByKey,
    getSettingValue,
    getPaymentSettings,
    invalidateSettingsCache,
    updateSetting,
};
