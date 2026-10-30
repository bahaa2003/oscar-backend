'use strict';

const whatsappService = require('./whatsapp.service');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { Setting } = require('../admin/setting.model');

const getStatus = async (_req, res) => {
    const setting = await Setting.findOne({ key: 'adminNotificationWhatsApp' }).select('value').lean();
    const adminNotificationNumber = String(setting?.value || process.env.ADMIN_NOTIFICATION_NUMBER || '').trim();
    sendSuccess(
        res,
        whatsappService.getStatus({ adminNotificationNumber }),
        'WhatsApp status retrieved'
    );
};

const reconnect = async (_req, res) => {
    const status = await whatsappService.reconnectWhatsAppClient();
    sendSuccess(res, status, 'WhatsApp reconnect triggered');
};

const reset = async (_req, res) => {
    const status = await whatsappService.resetWhatsAppClient();
    sendSuccess(res, status, 'WhatsApp session reset triggered');
};

module.exports = {
    getStatus,
    reconnect,
    reset,
};
