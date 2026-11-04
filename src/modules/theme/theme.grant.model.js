'use strict';

const mongoose = require('mongoose');

// Matches the existing server model and collection. Startup only reads grants;
// it never creates, renews, or modifies one.
const themeGrantSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true },
    planId: { type: String, enum: ['THEME_ULTRA'], required: true },
    grantedToUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    grantedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ['ACTIVE', 'EXPIRED', 'REVOKED'], default: 'ACTIVE', required: true },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    revokedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokeReason: { type: String, trim: true, maxlength: 500, default: null },
}, { timestamps: true, autoIndex: false });

themeGrantSchema.index({ scopeKey: 1, status: 1, expiresAt: -1 });
themeGrantSchema.index({ scopeKey: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });

module.exports = mongoose.model('PlatformThemeGrant', themeGrantSchema);
