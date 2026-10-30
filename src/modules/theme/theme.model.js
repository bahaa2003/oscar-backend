'use strict';

const mongoose = require('mongoose');

// A single KA installation has one platform theme. Legacy per-user theme
// collections are left untouched; these models use new collections.
const themeSettingsSchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true, unique: true },
    published: { type: mongoose.Schema.Types.Mixed, default: null },
    draft: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSuccessfulPublishAt: { type: Date, default: null },
    version: { type: Number, default: 0, min: 0 },
    writeLock: { type: Number, default: 0 },
}, { timestamps: true });

const themeHistorySchema = new mongoose.Schema({
    scopeKey: { type: String, enum: ['main'], required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    configuration: { type: mongoose.Schema.Types.Mixed, required: true },
    version: { type: Number, required: true },
    operation: { type: String, enum: ['PUBLISH', 'RESTORE'], required: true },
    planId: { type: String, enum: ['FREE', 'THEME_PRO', 'THEME_ULTRA'], default: 'FREE' },
    publishedAt: { type: Date, required: true },
}, { timestamps: true });
themeHistorySchema.index({ scopeKey: 1, version: 1 }, { unique: true });
themeHistorySchema.index({ scopeKey: 1, publishedAt: -1 });

module.exports = {
    ThemeSettings: mongoose.model('PlatformThemeSettings', themeSettingsSchema),
    ThemeHistory: mongoose.model('PlatformThemeHistory', themeHistorySchema),
};
