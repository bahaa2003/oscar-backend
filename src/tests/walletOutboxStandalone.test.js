'use strict';

const mongoose = require('mongoose');
const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { User, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Currency } = require('../modules/currency/currency.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { DepositCreditGuard } = require('../modules/deposits/depositCreditGuard.model');
const depositService = require('../modules/deposits/deposit.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { WalletOperation } = require('../modules/wallet/walletOperation.model');
const { AuditOutbox } = require('../modules/audit/auditOutbox.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { makeAuditEvent, deliverOneAuditEvent } = require('../modules/audit/auditOutbox.service');
const { WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../modules/audit/audit.constants');
const walletOperations = require('../modules/wallet/walletOperation.service');

describe('Wallet operation reliability on MongoDB Standalone', () => {
    let mongo;
    let user;

    beforeAll(async () => {
        await mongoose.disconnect();
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri());
        const topology = await mongoose.connection.db.admin().command({ hello: 1 });
        expect(topology.setName).toBeUndefined();
        expect(topology.msg).not.toBe('isdbgrid');
        await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
        await walletOperations.ensureWalletOperationIndexesReady();
        const group = await Group.create({ name: `standalone-${Date.now()}`, percentage: 0 });
        user = await User.create({
            name: 'Standalone wallet test', email: `wallet-${Date.now()}@test.invalid`, password: 'Password123!',
            groupId: group._id, role: 'CUSTOMER', status: USER_STATUS.ACTIVE, currency: 'USD', walletBalance: 25,
        });
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
    });

    const runBackendProcess = (mode, idempotencyKey) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            path.join(__dirname, 'fixtures', 'walletOperationProcess.js'),
            mongo.getUri(), mode, String(user._id), idempotencyKey,
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WALLET_OPERATION_LEASE_MS: '150' } });
        let output = '';
        child.stdout.on('data', (data) => { output += data.toString(); });
        child.stderr.on('data', (data) => { output += data.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
    });

    const startOutboxProcess = (mode, eventId, onLine = () => {}) => {
        const child = spawn(process.execPath, [
            path.join(__dirname, 'fixtures', 'auditOutboxProcess.js'), mongo.getUri(), mode, eventId,
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            for (const line of chunk.split(/\r?\n/).filter(Boolean)) onLine(line, child);
        });
        child.stderr.on('data', (data) => { output += data.toString(); });
        const closed = new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, output }));
        });
        return { child, closed };
    };

    const enqueueOutboxOnlyEvent = async (eventId) => {
        const event = makeAuditEvent({
            eventId, eventType: 'WALLET_DEBIT', actorId: user._id, actorRole: ACTOR_ROLES.SYSTEM,
            action: WALLET_ACTIONS.DEBIT, entityType: ENTITY_TYPES.WALLET, entityId: user._id,
            metadata: { standaloneIndependentWorker: true },
        });
        const { enqueueAuditEvents } = require('../modules/audit/auditOutbox.service');
        await enqueueAuditEvents([event]);
        await WalletTransaction.create({
            userId: user._id, type: 'DEBIT', amount: 1, balanceBefore: 25, balanceAfter: 24,
            idempotencyKey: eventId, status: 'COMPLETED', description: 'Outbox worker concurrency fixture',
        });
    };

    test('recovers a process stop after atomic balance update and before WalletTransaction', async () => {
        const key = `standalone-credit:${user._id}`;
        const original = WalletTransaction.findOneAndUpdate;
        let firstCall = true;
        WalletTransaction.findOneAndUpdate = async (...args) => {
            if (firstCall) {
                firstCall = false;
                throw new Error('simulated process interruption before wallet ledger write');
            }
            return original.apply(WalletTransaction, args);
        };

        await expect(walletOperations.executeWalletOperation({
            userId: user._id, idempotencyKey: key, operationType: 'TEST_CREDIT', transactionType: 'CREDIT',
            amount: 7.25, delta: 7.25, currency: 'USD', description: 'standalone recovery test', eventType: 'WALLET_CREDIT',
        })).rejects.toThrow('simulated process interruption');

        WalletTransaction.findOneAndUpdate = original;
        expect((await User.findById(user._id)).walletBalance).toBe(32.25);
        const recovery = await walletOperations.recoverPendingWalletOperations();
        expect(recovery.resumed).toBe(1);
        expect((await User.findById(user._id)).walletBalance).toBe(32.25);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(1);
        expect(await WalletOperation.countDocuments({ idempotencyKey: key, status: 'COMPLETED' })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId: `${key}:audit:WALLET_CREDIT`, status: 'DELIVERED' })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `${key}:audit:WALLET_CREDIT` })).toBe(1);
        expect((await User.findById(user._id).select('+activeWalletOperation')).activeWalletOperation).toBeUndefined();
    });

    test('a separate Backend process can recover after the original process exits abruptly', async () => {
        const key = `standalone-process-crash:${user._id}`;
        const before = (await User.findById(user._id)).walletBalance;
        const crashed = await runBackendProcess('crash-before-ledger', key);
        expect(crashed.code).toBe(73);
        expect((await User.findById(user._id)).walletBalance).toBe(before + 4.5);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const restartedBackend = await runBackendProcess('recover', key);
        expect(restartedBackend.code).toBe(0);
        expect((await User.findById(user._id)).walletBalance).toBe(before + 4.5);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `${key}:audit:WALLET_CREDIT` })).toBe(1);
    });

    test('a repeated request with the same operation key does not add or ledger the balance twice', async () => {
        const key = `standalone-debit:${user._id}`;
        const before = (await User.findById(user._id)).walletBalance;
        const input = {
            userId: user._id, idempotencyKey: key, operationType: 'TEST_DEBIT', transactionType: 'DEBIT',
            amount: 3, delta: -3, currency: 'USD', description: 'standalone idempotency test', eventType: 'WALLET_DEBIT',
        };
        await walletOperations.executeWalletOperation(input);
        await walletOperations.executeWalletOperation(input);
        expect((await User.findById(user._id)).walletBalance).toBe(before - 3);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `${key}:audit:WALLET_DEBIT` })).toBe(1);
    });

    test('recovers after WalletTransaction exists but Outbox write has not completed', async () => {
        const key = `standalone-outbox-gap:${user._id}`;
        const balanceBefore = (await User.findById(user._id)).walletBalance;
        const original = AuditOutbox.findOneAndUpdate;
        let interrupt = true;
        AuditOutbox.findOneAndUpdate = async (...args) => {
            if (interrupt) { interrupt = false; throw new Error('simulated stop before Outbox insert'); }
            return original.apply(AuditOutbox, args);
        };
        await expect(walletOperations.executeWalletOperation({
            userId: user._id, idempotencyKey: key, operationType: 'TEST_CREDIT', transactionType: 'CREDIT',
            amount: 2, delta: 2, currency: 'USD', description: 'outbox recovery test', eventType: 'WALLET_CREDIT',
        })).rejects.toThrow('simulated stop before Outbox insert');
        AuditOutbox.findOneAndUpdate = original;
        const before = await User.findById(user._id);
        expect(before.walletBalance).toBe(balanceBefore + 2);
        await walletOperations.recoverPendingWalletOperations();
        expect((await User.findById(user._id)).walletBalance).toBe(balanceBefore + 2);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `${key}:audit:WALLET_CREDIT` })).toBe(1);
    });

    test('AuditLog write followed by interruption before Outbox DELIVERED is idempotent', async () => {
        const eventId = `standalone-audit-crash:${user._id}`;
        const event = makeAuditEvent({
            eventId, eventType: 'WALLET_CREDIT', actorId: user._id, actorRole: ACTOR_ROLES.SYSTEM,
            action: WALLET_ACTIONS.CREDIT, entityType: ENTITY_TYPES.WALLET, entityId: user._id,
            metadata: { test: true },
        });
        const { enqueueAuditEvents } = require('../modules/audit/auditOutbox.service');
        await enqueueAuditEvents([event]);
        const original = AuditOutbox.updateOne;
        let interrupt = true;
        AuditOutbox.updateOne = async (filter, update, ...rest) => {
            if (interrupt && update?.$set?.status === 'DELIVERED') {
                interrupt = false;
                throw new Error('simulated stop after AuditLog insert');
            }
            return original.call(AuditOutbox, filter, update, ...rest);
        };
        await deliverOneAuditEvent(eventId);
        AuditOutbox.updateOne = original;
        await AuditOutbox.updateOne({ eventId }, { $set: { nextAttemptAt: new Date(0) } });
        await deliverOneAuditEvent(eventId);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
    });

    test('two Outbox workers cannot create duplicate final audit rows', async () => {
        const eventId = `standalone-workers:${user._id}`;
        const event = makeAuditEvent({
            eventId, eventType: 'WALLET_DEBIT', actorId: user._id, actorRole: ACTOR_ROLES.SYSTEM,
            action: WALLET_ACTIONS.DEBIT, entityType: ENTITY_TYPES.WALLET, entityId: user._id,
            metadata: { test: true },
        });
        const { enqueueAuditEvents } = require('../modules/audit/auditOutbox.service');
        await enqueueAuditEvents([event]);
        await Promise.all([deliverOneAuditEvent(eventId), deliverOneAuditEvent(eventId)]);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
    });

    test('two independent Backend processes race to claim one Outbox event on Standalone', async () => {
        const eventId = `independent-outbox-race:${user._id}`;
        await enqueueOutboxOnlyEvent(eventId);
        const first = startOutboxProcess('deliver', eventId);
        const second = startOutboxProcess('deliver', eventId);
        const results = await Promise.all([first.closed, second.closed]);
        expect(results.map((result) => result.code)).toEqual([0, 0]);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
    });

    test('expired Outbox lease fences the old process after a newer process delivers', async () => {
        const eventId = `independent-outbox-lease:${user._id}`;
        await enqueueOutboxOnlyEvent(eventId);
        let claimedResolve;
        const claimed = new Promise((resolve) => { claimedResolve = resolve; });
        const oldWorker = startOutboxProcess('claim-and-wait', eventId, (line) => {
            if (line === 'CLAIMED') claimedResolve();
        });
        await claimed;
        await AuditOutbox.updateOne({ eventId, status: 'PROCESSING' }, { $set: { leaseUntil: new Date(0) } });
        const newWorker = startOutboxProcess('deliver', eventId);
        const newResult = await newWorker.closed;
        expect(newResult.code).toBe(0);
        oldWorker.child.stdin.end('continue\n');
        const oldResult = await oldWorker.closed;
        expect(oldResult.code).toBe(0);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
        expect(oldResult.output).toContain('"delivered":false');
    });

    test('a temporary failure in an independent worker retries without duplicate financial records', async () => {
        const eventId = `independent-outbox-retry:${user._id}`;
        await enqueueOutboxOnlyEvent(eventId);
        const failedWorker = startOutboxProcess('transient-failure', eventId);
        expect((await failedWorker.closed).code).toBe(0);
        expect(await AuditLog.countDocuments({ eventId })).toBe(0);
        await AuditOutbox.updateOne({ eventId }, { $set: { nextAttemptAt: new Date(0) } });
        const retryWorker = startOutboxProcess('deliver', eventId);
        expect((await retryWorker.closed).code).toBe(0);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
    });

    test('an independent process crash after AuditLog insert resumes after lease expiry exactly once', async () => {
        const eventId = `independent-outbox-audit-crash:${user._id}`;
        await enqueueOutboxOnlyEvent(eventId);
        const crashedWorker = startOutboxProcess('crash-after-audit', eventId);
        expect((await crashedWorker.closed).code).toBe(74);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'PROCESSING' })).toBe(1);

        await AuditOutbox.updateOne({ eventId }, { $set: { leaseUntil: new Date(0) } });
        const resumedWorker = startOutboxProcess('deliver', eventId);
        expect((await resumedWorker.closed).code).toBe(0);
        expect(await AuditLog.countDocuments({ eventId })).toBe(1);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: eventId })).toBe(1);
        expect(await AuditOutbox.countDocuments({ eventId, status: 'DELIVERED' })).toBe(1);
    });

    test('currency conversion holds the wallet lease and atomically records the converted balance', async () => {
        await Currency.create({ code: 'EUR', name: 'Euro', symbol: '€', platformRate: 2, isActive: true });
        const admin = new mongoose.Types.ObjectId();
        const adminUsers = require('../modules/admin/admin.users.service');
        const balanceBefore = (await User.findById(user._id)).walletBalance;
        const updated = await adminUsers.updateUserCurrency(user._id, 'EUR', admin);
        expect(updated.currency).toBe('EUR');
        expect(updated.walletBalance).toBe(balanceBefore * 2);
        const op = await WalletOperation.findOne({ operationType: 'CURRENCY_CONVERSION', userId: user._id });
        expect(op.status).toBe('COMPLETED');
        expect(op.targetCurrency).toBe('EUR');
        expect(await AuditLog.countDocuments({ eventId: `${op.idempotencyKey}:audit:WALLET_CURRENCY_CONVERSION` })).toBe(1);
    });

    test('refunds and admin adjustments remain resumable and idempotent on standalone MongoDB', async () => {
        const wallet = require('../modules/wallet/wallet.service');
        const adminWallet = require('../modules/admin/admin.wallet.service');
        const adminId = new mongoose.Types.ObjectId();
        const reference = new mongoose.Types.ObjectId();
        const balanceBefore = (await User.findById(user._id)).walletBalance;
        const refundKey = `standalone-refund:${user._id}`;
        const refund = { userId: user._id, walletDeducted: 2, creditUsedAmount: 0, reference, idempotencyKey: refundKey };
        await wallet.refundWalletAtomic(refund);
        await wallet.refundWalletAtomic(refund);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: refundKey, type: 'REFUND' })).toBe(1);

        const adminKey = `standalone-admin-credit:${user._id}`;
        await adminWallet.addFunds(user._id, 5, 'standalone test adjustment', adminId, adminKey);
        await adminWallet.addFunds(user._id, 5, 'standalone test adjustment', adminId, adminKey);
        expect(await WalletTransaction.countDocuments({ idempotencyKey: adminKey, type: 'CREDIT' })).toBe(1);
        expect((await User.findById(user._id)).walletBalance).toBe(balanceBefore + 7);
        expect(await AuditLog.countDocuments({ eventId: `${adminKey}:audit:ADMIN_BALANCE_ADJUSTMENT` })).toBe(1);
    });

    test('purchase debit, refund, admin credit/debit, and both bulk debt paths recover after a ledger-stage failure', async () => {
        const wallet = require('../modules/wallet/wallet.service');
        const adminWallet = require('../modules/admin/admin.wallet.service');
        const adminId = new mongoose.Types.ObjectId();
        const groupId = user.groupId;
        const runWithLedgerFailure = async (operation) => {
            const original = WalletTransaction.findOneAndUpdate;
            let failOnce = true;
            WalletTransaction.findOneAndUpdate = async (...args) => {
                if (failOnce) { failOnce = false; throw new Error('injected failure at WalletTransaction stage'); }
                return original.apply(WalletTransaction, args);
            };
            try {
                await operation.run();
                if (!operation.swallowsFailure) throw new Error('Wallet operation did not expose the injected ledger failure.');
            } catch (error) {
                if (operation.swallowsFailure) throw error;
                expect(error.message).toContain('injected failure at WalletTransaction stage');
            } finally {
                WalletTransaction.findOneAndUpdate = original;
            }
            const recovered = await walletOperations.recoverPendingWalletOperations();
            expect(recovered.failed).toBe(0);
            expect(await WalletTransaction.countDocuments({ idempotencyKey: operation.key })).toBe(1);
            const stored = await WalletOperation.findOne({ idempotencyKey: operation.key });
            expect(stored.status).toBe('COMPLETED');
            expect((await User.findById(operation.userId).select('+activeWalletOperation')).activeWalletOperation).toBeUndefined();
        };

        const purchaseKey = `standalone-purchase-recovery:${user._id}`;
        const purchaseBefore = (await User.findById(user._id)).walletBalance;
        await runWithLedgerFailure({
            key: purchaseKey, userId: user._id,
            run: () => wallet.debitWalletAtomic({ userId: user._id, amount: 1, reference: new mongoose.Types.ObjectId(), idempotencyKey: purchaseKey }),
        });
        expect((await User.findById(user._id)).walletBalance).toBe(purchaseBefore - 1);

        const refundKey = `standalone-refund-recovery:${user._id}`;
        const refundBefore = (await User.findById(user._id)).walletBalance;
        await runWithLedgerFailure({
            key: refundKey, userId: user._id,
            run: () => wallet.refundWalletAtomic({ userId: user._id, walletDeducted: 1, creditUsedAmount: 0, reference: new mongoose.Types.ObjectId(), idempotencyKey: refundKey }),
        });
        expect((await User.findById(user._id)).walletBalance).toBe(refundBefore + 1);

        const creditKey = `standalone-admin-credit-recovery:${user._id}`;
        const creditBefore = (await User.findById(user._id)).walletBalance;
        await runWithLedgerFailure({
            key: creditKey, userId: user._id,
            run: () => adminWallet.addFunds(user._id, 1, 'recovery test credit', adminId, creditKey),
        });
        expect((await User.findById(user._id)).walletBalance).toBe(creditBefore + 1);

        const debitKey = `standalone-admin-debit-recovery:${user._id}`;
        const debitBefore = (await User.findById(user._id)).walletBalance;
        await runWithLedgerFailure({
            key: debitKey, userId: user._id,
            run: () => adminWallet.deductFunds(user._id, 1, 'recovery test debit', adminId, debitKey),
        });
        expect((await User.findById(user._id)).walletBalance).toBe(debitBefore - 1);

        for (const kind of ['inflation', 'deflation']) {
            const debtUser = await User.create({
                name: `Debt ${kind} recovery`, email: `debt-${kind}-${Date.now()}@test.invalid`, password: 'Password123!',
                groupId, role: 'CUSTOMER', status: USER_STATUS.ACTIVE, currency: 'USD', walletBalance: -10,
                creditLimit: 50, creditUsed: 10,
            });
            const baseKey = `standalone-debt-${kind}:${debtUser._id}`;
            const operationKey = `${baseKey}:${debtUser._id}`;
            const result = await runWithLedgerFailure({
                key: operationKey, userId: debtUser._id, swallowsFailure: true,
                run: () => kind === 'inflation'
                    ? adminWallet.adjustNegativeBalancesForInflation(10, adminId, 'USD', baseKey)
                    : adminWallet.adjustNegativeBalancesForDeflation(10, adminId, 'USD', baseKey),
            });
            expect(result).toBeUndefined();
            expect((await User.findById(debtUser._id)).walletBalance).toBe(kind === 'inflation' ? -11 : -9);
        }
    });

    test('deposit approval persists its ledger and both audit events on standalone MongoDB', async () => {
        const deposit = await DepositRequest.create({
            userId: user._id,
            paymentMethodId: 'bank-transfer',
            requestedAmount: 11,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 11,
            receiptImage: 'uploads/deposits/standalone-test.jpg',
        });
        const adminId = new mongoose.Types.ObjectId();
        await depositService.approveDeposit(deposit._id, adminId);
        expect((await DepositRequest.findById(deposit._id)).status).toBe('APPROVED');
        expect(await WalletTransaction.countDocuments({ reference: deposit._id, type: 'CREDIT' })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `deposit:${deposit._id}:credit:audit:WALLET_CREDIT` })).toBe(1);
        expect(await AuditLog.countDocuments({ eventId: `deposit:${deposit._id}:credit:audit:DEPOSIT_APPROVED` })).toBe(1);
    });

    test('all financial idempotency indexes exist with expected uniqueness and fail readiness closed', async () => {
        const indexMetadata = async (model) => model.collection.indexes();
        const findIndex = (indexes, field) => indexes.find((index) => index.key?.[field] === 1
            && Object.keys(index.key).length === 1);

        let indexes = await indexMetadata(DepositCreditGuard);
        expect(findIndex(indexes, 'idempotencyKey')).toMatchObject({ name: 'idempotencyKey_1', unique: true });
        expect(findIndex(indexes, 'depositId')).toMatchObject({ name: 'depositId_1', unique: true });
        indexes = await indexMetadata(WalletOperation);
        expect(findIndex(indexes, 'idempotencyKey')).toMatchObject({ name: 'idempotencyKey_1', unique: true });
        indexes = await indexMetadata(WalletTransaction);
        expect(findIndex(indexes, 'idempotencyKey')).toMatchObject({
            name: 'idempotencyKey_1', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        });
        indexes = await indexMetadata(AuditOutbox);
        expect(findIndex(indexes, 'eventId')).toMatchObject({ name: 'eventId_1', unique: true });
        indexes = await indexMetadata(AuditLog);
        expect(findIndex(indexes, 'eventId')).toMatchObject({
            name: 'eventId_1', unique: true, partialFilterExpression: { eventId: { $type: 'string' } },
        });

        const originalCreateIndex = AuditOutbox.collection.createIndex;
        await AuditOutbox.collection.dropIndex('eventId_1');
        AuditOutbox.collection.createIndex = async () => { throw new Error('injected unique index build failure'); };
        try {
            await expect(walletOperations.ensureWalletOperationIndexesReady()).rejects.toThrow('injected unique index build failure');
        } finally {
            AuditOutbox.collection.createIndex = originalCreateIndex;
            await AuditOutbox.collection.createIndex({ eventId: 1 }, { unique: true });
        }
        await walletOperations.ensureWalletOperationIndexesReady();
        await depositService.assertDepositCreditGuardIndexesReady();
    });
});
