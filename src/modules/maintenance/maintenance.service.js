'use strict';

const { Setting } = require('../admin/setting.model');
const settingsService = require('../admin/admin.settings.service');
const { ValidationError } = require('../../shared/errors/AppError');

const MAINTENANCE_SETTING_KEY = 'maintenanceMode';

const getStatus = async () => {
    const setting = await Setting.findOne({ key: MAINTENANCE_SETTING_KEY }).select('value').lean();
    return { enabled: setting?.value === true };
};

const setStatus = async (enabled, adminId) => {
    if (typeof enabled !== 'boolean') {
        throw new ValidationError('Maintenance status must be a boolean.');
    }

    await Setting.updateOne({ key: MAINTENANCE_SETTING_KEY }, {
        $setOnInsert: {
            key: MAINTENANCE_SETTING_KEY,
            value: false,
            description: 'When true, the public storefront and customer API are temporarily unavailable.',
        },
    }, { upsert: true });
    const setting = await settingsService.updateSetting(MAINTENANCE_SETTING_KEY, enabled, adminId);
    return { enabled: setting.value === true };
};

module.exports = { getStatus, setStatus };
