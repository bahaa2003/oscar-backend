'use strict';

const mongoose = require('mongoose');

const googleOAuthLoginCodeSchema = new mongoose.Schema(
    {
        codeHash: {
            type: String,
            required: true,
            trim: true,
        },

        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },

        provider: {
            type: String,
            enum: ['GOOGLE'],
            default: 'GOOGLE',
            required: true,
            index: true,
        },

        codeChallenge: {
            type: String,
            required: true,
            trim: true,
        },

        codeChallengeMethod: {
            type: String,
            enum: ['S256'],
            required: true,
            default: 'S256',
        },

        oauthStateId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'GoogleOAuthState',
            default: null,
        },

        expiresAt: {
            type: Date,
            required: true,
        },

        consumedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

googleOAuthLoginCodeSchema.index(
    { codeHash: 1 },
    { unique: true, name: 'unique_google_oauth_login_code_hash' }
);

googleOAuthLoginCodeSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'google_oauth_login_code_ttl' }
);

googleOAuthLoginCodeSchema.index(
    { codeHash: 1, consumedAt: 1, expiresAt: 1 },
    { name: 'google_oauth_login_code_consume_lookup' }
);

module.exports = mongoose.model('GoogleOAuthLoginCode', googleOAuthLoginCodeSchema);
