'use strict';

const readline = require('readline');
const mongoose = require('mongoose');
const { AuditOutbox } = require('../../modules/audit/auditOutbox.model');
const { AuditLog } = require('../../modules/audit/audit.model');
const { deliverOneAuditEvent } = require('../../modules/audit/auditOutbox.service');

const waitForParent = () => new Promise((resolve) => {
    const input = readline.createInterface({ input: process.stdin });
    input.once('line', () => { input.close(); resolve(); });
});

const run = async () => {
    const [uri, mode, eventId] = process.argv.slice(2);
    await mongoose.connect(uri);
    if (mode === 'claim-and-wait') {
        const original = AuditLog.collection.updateOne.bind(AuditLog.collection);
        let paused = false;
        AuditLog.collection.updateOne = async (...args) => {
            if (!paused) {
                paused = true;
                process.stdout.write('CLAIMED\n');
                await waitForParent();
            }
            return original(...args);
        };
        const result = await deliverOneAuditEvent(eventId);
        process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    } else if (mode === 'crash-after-audit') {
        const original = AuditOutbox.updateOne;
        AuditOutbox.updateOne = async (filter, update, ...args) => {
            if (update?.$set?.status === 'DELIVERED') process.exit(74);
            return original.call(AuditOutbox, filter, update, ...args);
        };
        await deliverOneAuditEvent(eventId);
        throw new Error('Failure injection did not stop the process after AuditLog insert.');
    } else if (mode === 'transient-failure') {
        const original = AuditLog.collection.updateOne.bind(AuditLog.collection);
        AuditLog.collection.updateOne = async () => { throw new Error('injected temporary audit storage failure'); };
        await deliverOneAuditEvent(eventId);
        AuditLog.collection.updateOne = original;
        process.stdout.write('FAILED_ONCE\n');
    } else if (mode === 'deliver') {
        const result = await deliverOneAuditEvent(eventId);
        process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    } else {
        throw new Error(`Unknown Outbox worker mode: ${mode}`);
    }
    await mongoose.disconnect();
};

run().catch(async (error) => {
    console.error(error.stack || error.message);
    try { await mongoose.disconnect(); } catch (_) { /* process teardown */ }
    process.exitCode = 1;
});
