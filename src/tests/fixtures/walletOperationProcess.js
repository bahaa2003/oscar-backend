'use strict';

const mongoose = require('mongoose');
const { User } = require('../../modules/users/user.model');
const { WalletOperation } = require('../../modules/wallet/walletOperation.model');
const { WalletTransaction } = require('../../modules/wallet/walletTransaction.model');
const walletOperations = require('../../modules/wallet/walletOperation.service');

const run = async () => {
    const [uri, mode, userId, idempotencyKey] = process.argv.slice(2);
    await mongoose.connect(uri);
    if (mode === 'crash-before-ledger') {
        const original = WalletTransaction.findOneAndUpdate;
        WalletTransaction.findOneAndUpdate = async (...args) => {
            WalletTransaction.findOneAndUpdate = original;
            process.exit(73);
        };
        await walletOperations.executeWalletOperation({
            userId, idempotencyKey, operationType: 'PROCESS_CRASH_TEST', transactionType: 'CREDIT',
            amount: 4.5, delta: 4.5, currency: 'USD', eventType: 'WALLET_CREDIT',
            description: 'independent Backend process crash test',
        });
        throw new Error('Failure injection did not stop the process at the requested checkpoint.');
    }
    if (mode === 'recover') {
        const result = await walletOperations.recoverPendingWalletOperations({ limit: 100 });
        if (result.failed) throw new Error(`${result.failed} wallet recovery operation(s) did not resume.`);
    } else if (mode === 'resume') {
        await walletOperations.resumeWalletOperation(idempotencyKey);
    } else {
        throw new Error(`Unknown worker mode: ${mode}`);
    }
    await mongoose.disconnect();
};

run().catch(async (error) => {
    console.error(error.stack || error.message);
    try { await mongoose.disconnect(); } catch (_) { /* process teardown */ }
    process.exitCode = 1;
});
