'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { User, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { DepositCreditGuard } = require('../modules/deposits/depositCreditGuard.model');
const { WalletOperation } = require('../modules/wallet/walletOperation.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { AuditOutbox } = require('../modules/audit/auditOutbox.model');
const { AuditLog } = require('../modules/audit/audit.model');

const stages = ['prepared', 'reservation', 'balance', 'transaction', 'outbox', 'audit', 'completed', 'released'];
const actions = [
    { name: 'deposit', eventType: null, delta: 5, deposit: true, stages: stages.filter((stage) => stage !== 'completed') },
    { name: 'purchase', eventType: 'WALLET_DEBIT', delta: -5 },
    { name: 'refund', eventType: 'WALLET_REFUND', delta: 5 },
    { name: 'admin-credit', eventType: 'ADMIN_BALANCE_ADJUSTMENT', delta: 5 },
    { name: 'admin-debit', eventType: 'ADMIN_BALANCE_ADJUSTMENT', delta: -5 },
    { name: 'bulk-increase', eventType: 'WALLET_DEBT_ADJUSTMENT', delta: -10, debt: true },
    { name: 'bulk-reduction', eventType: 'WALLET_DEBT_ADJUSTMENT', delta: 10, debt: true },
];

const startProcess = (script, args, env = {}) => {
    const child = spawn(process.execPath, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const closed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Process timed out: ${script}\n${output}`));
        }, 30_000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, output });
        });
    });
    return { child, closed };
};

const freePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
};

const portAcceptsConnections = (port) => new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
});

describe('Complete standalone financial failure-injection matrix', () => {
    let mongo;
    let groupId;
    let scenarioMongoUri;
    let scenarioNumber = 0;
    const fixture = path.join(__dirname, 'fixtures', 'financialFailureProcess.js');

    beforeAll(async () => {
        await mongoose.disconnect();
        mongo = await MongoMemoryServer.create();
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
    });

    beforeEach(async () => {
        await mongoose.disconnect();
        scenarioMongoUri = mongo.getUri(`release_gate_case_${++scenarioNumber}`);
        await mongoose.connect(scenarioMongoUri, { autoIndex: false });
        await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
        const group = await Group.create({ name: `release-gate-${scenarioNumber}`, percentage: 0 });
        groupId = group._id;
    });

    const scenarios = actions.flatMap((action) => (action.stages || stages).map((stage) => [action, stage]));

    test.each(scenarios)('%s recovery after %s', async (action, stage) => {
        const user = await User.create({
            name: `${action.name}-${stage}`, email: `${action.name}-${stage}-${new mongoose.Types.ObjectId()}@test.invalid`,
            password: 'Password123!', groupId, role: 'CUSTOMER', status: USER_STATUS.ACTIVE,
            currency: 'USD', walletBalance: action.debt ? -100 : 100,
            creditLimit: action.debt ? 500 : 0, creditUsed: action.debt ? 100 : 0,
        });
        const actorId = new mongoose.Types.ObjectId();
        const key = `release-gate:${action.name}:${stage}:${new mongoose.Types.ObjectId()}`;
        let subjectId = new mongoose.Types.ObjectId();
        if (action.deposit) {
            const deposit = await DepositRequest.create({
                userId: user._id, paymentMethodId: 'isolated-test', requestedAmount: 5, currency: 'USD',
                exchangeRate: 1, amountUsd: 5, receiptImage: 'uploads/deposits/release-gate.jpg',
            });
            subjectId = deposit._id;
        }
        const initialBalance = action.debt ? -100 : 100;
        const operationKey = action.deposit ? `deposit:${subjectId}:credit`
            : action.name.startsWith('bulk-') ? `${key}:${user._id}` : key;
        const invocationKey = action.deposit ? operationKey : key;
        const childArgs = [scenarioMongoUri, 'crash', action.name, stage, String(user._id), String(subjectId), invocationKey, String(actorId)];
        const crashed = await startProcess(fixture, childArgs, {
            WALLET_OPERATION_LEASE_MS: '100', NODE_ENV: 'test', WHATSAPP_ENABLED: 'false',
        }).closed;
        const expectedCode = 80 + stages.indexOf(stage);
        if (crashed.code !== expectedCode) throw new Error(`Crash process exited ${crashed.code}, expected ${expectedCode}:\n${crashed.output}`);
        expect(crashed.code).toBe(expectedCode, crashed.output);
        expect(crashed.signal).toBeNull();
        expect(crashed.output).toContain('MONGO_TOPOLOGY Single');
        expect(crashed.output).toContain(`CRASH_POINT_REACHED ${stage}`);

        await Promise.all([
            WalletOperation.updateMany({ idempotencyKey: operationKey }, { $set: { leaseUntil: new Date(0) } }),
            DepositCreditGuard.updateMany({ depositId: subjectId }, { $set: { leaseUntil: new Date(0) } }),
            User.updateOne({ _id: user._id, 'activeWalletOperation.operationKey': operationKey }, { $set: { 'activeWalletOperation.leaseUntil': new Date(0) } }),
            AuditOutbox.updateMany({ status: 'PROCESSING' }, { $set: { leaseUntil: new Date(0) } }),
        ]);

        const resumed = await startProcess(fixture, [scenarioMongoUri, 'recover', action.name, stage, String(user._id), String(subjectId), invocationKey, String(actorId)], {
            WALLET_OPERATION_LEASE_MS: '100', NODE_ENV: 'test', WHATSAPP_ENABLED: 'false',
        }).closed;
        if (resumed.code !== 0) throw new Error(`Recovery process exited ${resumed.code}:\n${resumed.output}`);
        expect(resumed.code).toBe(0, resumed.output);
        expect(resumed.output).toContain('MONGO_TOPOLOGY Single');

        const expectedBalance = initialBalance + action.delta;
        const approvalNotStarted = action.deposit && stage === 'reservation';
        expect((await User.findById(user._id)).walletBalance).toBe(approvalNotStarted ? initialBalance : expectedBalance);
        expect(await User.findOne({ _id: user._id, 'activeWalletOperation.operationKey': { $exists: true } })).toBeNull();

        if (action.deposit) {
            expect((await DepositRequest.findById(subjectId)).status).toBe(approvalNotStarted ? 'PENDING' : 'APPROVED');
            expect(await DepositCreditGuard.countDocuments({ depositId: subjectId, status: 'COMPLETED' })).toBe(approvalNotStarted ? 0 : 1);
            expect(await WalletOperation.countDocuments({ idempotencyKey: operationKey })).toBe(0);
            expect(await WalletTransaction.countDocuments({ idempotencyKey: operationKey })).toBe(approvalNotStarted ? 0 : 1);
            for (const eventType of ['WALLET_CREDIT', 'DEPOSIT_APPROVED']) {
                const eventId = `${operationKey}:audit:${eventType}`;
                expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(approvalNotStarted ? 0 : 1);
                expect(await AuditLog.countDocuments({ eventId })).toBe(approvalNotStarted ? 0 : 1);
            }
        } else {
            expect(await WalletTransaction.countDocuments({ idempotencyKey: operationKey })).toBe(1);
            const operation = await WalletOperation.findOne({ idempotencyKey: operationKey });
            expect(operation.status).toBe('COMPLETED');
            const eventId = `${operationKey}:audit:${action.eventType}`;
            expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
            expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        }
    });
});

describe('server.js startup index readiness over a real HTTP process', () => {
    let mongo;
    const serverScript = path.join(__dirname, '..', 'server.js');

    beforeAll(async () => {
        await mongoose.disconnect();
        mongo = await MongoMemoryServer.create();
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
    });

    const serverEnv = (port, mongoUri = mongo.getUri()) => ({
        MONGO_URI: mongoUri, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: 'isolated-release-test-secret',
        WHATSAPP_ENABLED: 'false', WHATSAPP_AUTH_DATA_PATH: path.join(__dirname, '..', '..', '.tmp', 'release-gate-wa-disabled'),
    });

    test('starts HTTP only after required indexes are ready, then shuts down cleanly', async () => {
        const port = await freePort();
        const child = startProcess(serverScript, [], serverEnv(port));
        let healthy = false;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && !healthy) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`);
                healthy = response.status === 200;
            } catch (_) { await new Promise((resolve) => setTimeout(resolve, 100)); }
        }
        expect(healthy).toBe(true);
        expect(await portAcceptsConnections(port)).toBe(true);
        await mongoose.connect(mongo.getUri(), { autoIndex: false });
        const requiredIndexes = [
            [WalletOperation, 'idempotencyKey'],
            [DepositCreditGuard, 'idempotencyKey'],
            [DepositCreditGuard, 'depositId'],
            [WalletTransaction, 'idempotencyKey'],
            [AuditOutbox, 'eventId'],
            [AuditLog, 'eventId'],
        ];
        for (const [model, field] of requiredIndexes) {
            const indexes = await model.collection.indexes();
            expect(indexes.some((index) => index.unique === true
                && Object.keys(index.key || {}).length === 1 && index.key[field] === 1)).toBe(true);
        }
        await mongoose.disconnect();
        child.child.kill('SIGTERM');
        const stopped = await child.closed;
        expect(stopped.signal === 'SIGTERM' || stopped.code === 0).toBe(true);
        expect(await portAcceptsConnections(port)).toBe(false);
    });

    test('duplicate data prevents startup, closes MongoDB, and never opens the HTTP port', async () => {
        const port = await freePort();
        const failureMongoUri = mongo.getUri('release-gate-index-failure');
        await mongoose.connect(failureMongoUri, { autoIndex: false });
        const collection = mongoose.connection.db.collection('walletoperations');
        await collection.insertMany([
            { idempotencyKey: 'duplicate-release-gate-key', createdAt: new Date() },
            { idempotencyKey: 'duplicate-release-gate-key', createdAt: new Date() },
        ]);
        await mongoose.disconnect();

        let observedOpenPort = false;
        let observe = true;
        const observer = (async () => {
            while (observe) {
                if (await portAcceptsConnections(port)) observedOpenPort = true;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        })();
        const failed = await startProcess(serverScript, [], serverEnv(port, failureMongoUri)).closed;
        observe = false;
        await observer;
        expect(failed.code).not.toBe(0);
        expect(failed.output).toContain('duplicate');
        expect(observedOpenPort).toBe(false);
        expect(await portAcceptsConnections(port)).toBe(false);
        await expect(fetch(`http://127.0.0.1:${port}/api/deposits`)).rejects.toThrow();
    });
});
