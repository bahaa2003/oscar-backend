'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['DISABLE', 'ENABLE'], required: true },
    reason: { type: String, required: true, maxlength: 500 },
}, { timestamps: true });
schema.index({ createdAt: -1 });
module.exports = mongoose.model('ThemeAdminAudit', schema);
