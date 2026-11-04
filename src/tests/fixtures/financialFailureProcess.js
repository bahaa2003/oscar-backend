'use strict';

const mongoose = require('mongoose');
const { User } = require('../../modules/users/user.model');
const { DepositRequest } = require('../../modules/deposits/deposit.model');
const { DepositCreditGuard } = require('../../modules/deposits/depositCreditGuard.model');
const { WalletOperation } = require('../../modules/wallet/walletOperation.model');
const { WalletTransaction } = require('../../modules/wallet/walletTransaction.model');
const { AuditOutbox } = require('../../modules/audit/auditOutbox.model');
const { AuditLog } = require('../../modules/audit/audit.model');
const walletOperations = require('../../modules/wallet/walletOperation.service');
const depositService = require('../../modules/deposits/deposit.service');
const walletService = require('../../modules/wallet/wallet.service');
const adminWallet = require('../../modules/admin/admin.wallet.service');

const patchAfterWrite = (model, method, predicate, crashCode) => {
    const original = model[method];
    model[method] = function (...args) {
        const result = original.apply(this, args);
        const afterWrite = (value) => {
            if (predicate(args, value)) {
                process.stdout.write(`CRASH_POINT_REACHED ${process.argv[5]}\n`);
                process.exit(crashCode);
            }
            return value;
        };
        // Preserve Mongoose Query chaining (e.g. findOneAndUpdate(...).select(...))
        // while injecting the crash only after MongoDB has acknowledged the write.
        if (result && typeof result.exec === 'function' && typeof result.then === 'function') {
            const originalThen = result.then.bind(result);
            result.then = (resolve, reject) => originalThen((value) => {
                const checked = afterWrite(value);
                return typeof resolve === 'function' ? resolve(checked) : checked;
            }, reject);
            return result;
        }
        return Promise.resolve(result).then(afterWrite);
    };
};

const run = async () => {
    const [uri, mode, action, stage, userId, subjectId, idempotencyKey, adminId] = process.argv.slice(2);
    await mongoose.connect(uri, { autoIndex: false });
    const topologyType = mongoose.connection.client.topology.description.type;
    if (topologyType !== 'Single') throw new Error(`Failure matrix requires MongoDB Standalone; connected topology is ${topologyType}.`);
    process.stdout.write(`MONGO_TOPOLOGY ${topologyType}\n`);

    if (mode === 'recover') {
        if (action === 'deposit') {
            const result = await depositService.resumePendingDepositApprovals();
            if (result.failed) throw new Error(`Deposit recovery left ${result.failed} pending item(s).`);
        } else {
            const result = await walletOperations.recoverPendingWalletOperations({ limit: 500 });
            if (result.failed) {
                const failed = await WalletOperation.find({ status: { $in: ['PREPARED', 'APPLIED', 'LEDGER_RECORDED', 'OUTBOX_RECORDED'] } })
                    .select('idempotencyKey status lastError failureCode leaseUntil').lean();
                console.error(`Wallet recovery left ${result.failed} pending item(s): ${JSON.stringify(failed)}`);
                throw new Error(`Wallet recovery left ${result.failed} pending item(s).`);
            }
        }
        await require('../../modules/audit/auditOutbox.service').processAuditOutboxBatch({ limit: 500 });
        await mongoose.disconnect();
        return;
    }
    if (mode !== 'crash') throw new Error(`Unknown mode ${mode}`);

    const stageCode = 80 + ['prepared', 'reservation', 'balance', 'transaction', 'outbox', 'audit', 'completed', 'released'].indexOf(stage);
    if (stageCode < 80) throw new Error(`Unknown failure stage ${stage}`);
    const isDeposit = action === 'deposit';
    const operationKey = action.startsWith('bulk-') ? `${idempotencyKey}:${userId}` : idempotencyKey;
    let targetOperationId = null;

    if (!isDeposit) {
        const original = WalletOperation.findOneAndUpdate;
        WalletOperation.findOneAndUpdate = function (...args) {
            const query = original.apply(this, args);
            if (args[0]?.idempotencyKey !== operationKey || !query || typeof query.then !== 'function') return query;
            const originalThen = query.then.bind(query);
            query.then = (resolve, reject) => originalThen((value) => {
                if (value?._id) targetOperationId = value._id;
                return typeof resolve === 'function' ? resolve(value) : value;
            }, reject);
            return query;
        };
    }

    if (stage === 'prepared') {
        patchAfterWrite(isDeposit ? DepositCreditGuard : WalletOperation, 'findOneAndUpdate',
            ([filter, update, options]) => Boolean(options?.upsert && filter?.idempotencyKey === operationKey
                && (!isDeposit || update?.$setOnInsert?.status === 'PREPARED')), stageCode);
    }
    if (stage === 'reservation') {
        patchAfterWrite(User, 'findOneAndUpdate', ([, update]) => {
            const lock = update?.$set?.activeWalletOperation;
            return Boolean(lock && (isDeposit
                ? String(lock.depositId) === String(subjectId)
                : lock.operationKey === operationKey));
        }, stageCode);
    }
    if (stage === 'balance') {
        patchAfterWrite(User, 'findOneAndUpdate', ([filter, update]) => String(filter?._id) === String(userId)
            && Array.isArray(update) && JSON.stringify(update).includes('activeWalletOperation.status')
            && JSON.stringify(update).includes('APPLIED'), stageCode);
    }
    if (stage === 'transaction') {
        patchAfterWrite(WalletTransaction, 'findOneAndUpdate', ([filter]) => filter?.idempotencyKey === operationKey, stageCode);
    }
    if (stage === 'outbox') {
        patchAfterWrite(AuditOutbox, 'findOneAndUpdate', ([, update]) => update?.$setOnInsert?.eventId?.startsWith(`${operationKey}:audit:`), stageCode);
    }
    if (stage === 'audit') {
        patchAfterWrite(AuditLog.collection, 'updateOne', ([filter]) => filter?.eventId?.startsWith(`${operationKey}:audit:`), stageCode);
    }
    if (stage === 'completed') {
        patchAfterWrite(WalletOperation, 'updateOne', ([filter, update]) => String(filter?._id) === String(targetOperationId)
            && update?.$set?.status === 'COMPLETED', stageCode);
    }
    if (stage === 'released') {
        patchAfterWrite(User, 'updateOne', ([filter, update]) => filter?.['activeWalletOperation.operationKey'] === operationKey
            && Boolean(update?.$unset?.activeWalletOperation), stageCode);
    }

    if (isDeposit) {
        await depositService.approveDeposit(subjectId, adminId);
    } else if (action === 'purchase') {
        await walletService.debitWalletAtomic({ userId, amount: 5, reference: new mongoose.Types.ObjectId(), idempotencyKey, description: 'Failure-matrix purchase debit' });
    } else if (action === 'refund') {
        await walletService.refundWalletAtomic({ userId, walletDeducted: 5, creditUsedAmount: 0, reference: new mongoose.Types.ObjectId(), idempotencyKey, description: 'Failure-matrix refund' });
    } else if (action === 'admin-credit') {
        await adminWallet.addFunds(userId, 5, 'Failure-matrix admin credit', adminId, idempotencyKey);
    } else if (action === 'admin-debit') {
        await adminWallet.deductFunds(userId, 5, 'Failure-matrix admin debit', adminId, idempotencyKey);
    } else if (action === 'bulk-increase') {
        await adminWallet.adjustNegativeBalancesForInflation(10, adminId, 'USD', idempotencyKey);
    } else if (action === 'bulk-reduction') {
        await adminWallet.adjustNegativeBalancesForDeflation(10, adminId, 'USD', idempotencyKey);
    } else {
        throw new Error(`Unknown action ${action}`);
    }
    throw new Error(`Requested failure stage '${stage}' was not reached by ${action}.`);
};

run().catch(async (error) => {
    console.error(error.stack || error.message);
    try { await mongoose.disconnect(); } catch (_) { /* process teardown */ }
    process.exitCode = 1;
});
