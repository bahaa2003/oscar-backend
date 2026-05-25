'use strict';

const whatsappService = require('./whatsapp.service');
const { sendSuccess } = require('../../shared/utils/apiResponse');

const getStatus = async (_req, res) => {
    sendSuccess(
        res,
        whatsappService.getStatus(),
        'WhatsApp status retrieved'
    );
};

const reconnect = async (_req, res) => {
    const status = await whatsappService.reconnectWhatsAppClient();
    sendSuccess(res, status, 'WhatsApp reconnect triggered');
};

module.exports = {
    getStatus,
    reconnect,
};
