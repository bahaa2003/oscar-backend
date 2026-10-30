'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { ThemeSettings, ThemeHistory } = require('../src/modules/theme/theme.model');
const { ThemeSubscription, ThemePayment, ThemeActivationCode, ThemeCodeUse } = require('../src/modules/theme/subscription.model');

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI);
    try {
        for (const model of [ThemeSettings, ThemeHistory, ThemeSubscription, ThemePayment, ThemeActivationCode, ThemeCodeUse]) {
            await model.createIndexes();
            console.log(`Indexes ready: ${model.modelName}`);
        }
    } finally { await mongoose.disconnect(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
