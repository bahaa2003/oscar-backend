'use strict';

const mongoose = require('mongoose');
const { resumeDepositApproval } = require('../../modules/deposits/deposit.service');

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_TEST_URI);
        await resumeDepositApproval(process.argv[2]);
        if (process.send) process.send({ ok: true });
    } catch (error) {
        if (process.send) process.send({ ok: false, message: error.message, code: error.code });
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        if (process.connected) process.disconnect();
    }
};

run();
