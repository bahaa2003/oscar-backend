'use strict';

const mongoose = require('mongoose');

const googleOAuthStateSchema = new mongoose.Schema(
    {
        stateHash: {
            type: String,
            required: true,
            trim: true,
        },

        browserBindingHash: {
            type: String,
            required: true,
            trim: true,
        },

        provider: {
            type: String,
            enum: ['GOOGLE'],
            default: 'GOOGLE',
            required: true,
            index: true,
        },

        version: {
            type: String,
            enum: ['v1'],
            default: 'v1',
            required: true,
        },

        referrerCode: {
            type: String,
            trim: true,
            uppercase: true,
            default: null,
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

googleOAuthStateSchema.index(
    { stateHash: 1 },
    { unique: true, name: 'unique_google_oauth_state_hash' }
);

googleOAuthStateSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'google_oauth_state_ttl' }
);

googleOAuthStateSchema.index(
    { stateHash: 1, browserBindingHash: 1, consumedAt: 1, expiresAt: 1 },
    { name: 'google_oauth_state_consume_lookup' }
);

module.exports = mongoose.model('GoogleOAuthState', googleOAuthStateSchema);
