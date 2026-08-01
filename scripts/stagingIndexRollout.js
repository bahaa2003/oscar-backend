'use strict';

require('dotenv').config();

const mongoose = require('mongoose');

const BLOCKING_DB_NAME_PATTERN = /(prod|production|live)/i;

const INDEX_ROLLOUTS = Object.freeze([
    {
        collection: 'users',
        name: 'unique_referral_code',
        key: { referralCode: 1 },
        options: {
            unique: true,
            name: 'unique_referral_code',
            partialFilterExpression: { referralCode: { $type: 'string', $gt: '' } },
        },
        duplicateMatch: { referralCode: { $type: 'string', $gt: '' } },
        duplicateGroupId: { referralCode: '$referralCode' },
    },
    {
        collection: 'users',
        name: 'referredBy_1_referredAt_-1',
        key: { referredBy: 1, referredAt: -1 },
        options: { name: 'referredBy_1_referredAt_-1' },
    },
    {
        collection: 'groups',
        name: 'unique_non_deleted_default_group',
        key: { isDefault: 1 },
        options: {
            unique: true,
            name: 'unique_non_deleted_default_group',
            partialFilterExpression: { isDefault: true, deletedAt: null },
        },
        duplicateMatch: { isDefault: true, deletedAt: null },
        duplicateGroupId: { isDefault: '$isDefault' },
    },
    {
        collection: 'wallettransactions',
        name: 'unique_wallet_source_operation',
        key: { userId: 1, sourceType: 1, sourceId: 1, operation: 1 },
        options: {
            unique: true,
            name: 'unique_wallet_source_operation',
            partialFilterExpression: {
                sourceType: { $type: 'string' },
                sourceId: { $type: 'objectId' },
                operation: { $type: 'string' },
            },
        },
        duplicateMatch: {
            sourceType: { $type: 'string' },
            sourceId: { $type: 'objectId' },
            operation: { $type: 'string' },
        },
        duplicateGroupId: {
            userId: '$userId',
            sourceType: '$sourceType',
            sourceId: '$sourceId',
            operation: '$operation',
        },
    },
    {
        collection: 'referralcommissions',
        name: 'unique_referral_commission_per_deposit',
        key: { depositId: 1 },
        options: { unique: true, name: 'unique_referral_commission_per_deposit' },
        duplicateMatch: { depositId: { $type: 'objectId' } },
        duplicateGroupId: { depositId: '$depositId' },
    },
    {
        collection: 'referralcommissions',
        name: 'unique_referral_commission_idempotency_key',
        key: { idempotencyKey: 1 },
        options: { unique: true, name: 'unique_referral_commission_idempotency_key' },
        duplicateMatch: { idempotencyKey: { $type: 'string', $gt: '' } },
        duplicateGroupId: { idempotencyKey: '$idempotencyKey' },
    },
    {
        collection: 'referralcommissions',
        name: 'referrerId_1_status_1_createdAt_-1',
        key: { referrerId: 1, status: 1, createdAt: -1 },
        options: { name: 'referrerId_1_status_1_createdAt_-1' },
    },
    {
        collection: 'referralcommissions',
        name: 'referredUserId_1_createdAt_-1',
        key: { referredUserId: 1, createdAt: -1 },
        options: { name: 'referredUserId_1_createdAt_-1' },
    },
    {
        collection: 'referralcommissions',
        name: 'walletTransactionId_1',
        key: { walletTransactionId: 1 },
        options: { name: 'walletTransactionId_1' },
    },
    {
        collection: 'referralpayoutrequests',
        name: 'unique_referral_payout_idempotency_key',
        key: { idempotencyKey: 1 },
        options: { unique: true, name: 'unique_referral_payout_idempotency_key' },
        duplicateMatch: { idempotencyKey: { $type: 'string', $gt: '' } },
        duplicateGroupId: { idempotencyKey: '$idempotencyKey' },
    },
    {
        collection: 'referralpayoutrequests',
        name: 'referrerId_1_status_1_requestedAt_-1',
        key: { referrerId: 1, status: 1, requestedAt: -1 },
        options: { name: 'referrerId_1_status_1_requestedAt_-1' },
    },
    {
        collection: 'referralpayoutrequests',
        name: 'status_1_method_1_requestedAt_-1',
        key: { status: 1, method: 1, requestedAt: -1 },
        options: { name: 'status_1_method_1_requestedAt_-1' },
    },
    {
        collection: 'resellerapplications',
        name: 'unique_reseller_application_number',
        key: { applicationNumber: 1 },
        options: { unique: true, name: 'unique_reseller_application_number' },
        duplicateMatch: { applicationNumber: { $type: 'string', $gt: '' } },
        duplicateGroupId: { applicationNumber: '$applicationNumber' },
    },
    {
        collection: 'resellerapplications',
        name: 'unique_reseller_application_idempotency_key',
        key: { idempotencyKey: 1 },
        options: { unique: true, name: 'unique_reseller_application_idempotency_key' },
        duplicateMatch: { idempotencyKey: { $type: 'string', $gt: '' } },
        duplicateGroupId: { idempotencyKey: '$idempotencyKey' },
    },
    {
        collection: 'resellerapplications',
        name: 'unique_pending_reseller_application_per_user',
        key: { userId: 1, status: 1 },
        options: {
            unique: true,
            name: 'unique_pending_reseller_application_per_user',
            partialFilterExpression: { status: 'PENDING' },
        },
        duplicateMatch: { status: 'PENDING' },
        duplicateGroupId: { userId: '$userId', status: '$status' },
    },
    {
        collection: 'resellerapplications',
        name: 'status_1_submittedAt_-1',
        key: { status: 1, submittedAt: -1 },
        options: { name: 'status_1_submittedAt_-1' },
    },
    {
        collection: 'resellerapplications',
        name: 'assignedGroupId_1_status_1',
        key: { assignedGroupId: 1, status: 1 },
        options: { name: 'assignedGroupId_1_status_1' },
    },
    {
        collection: 'orders',
        name: 'unique_order_number_non_empty',
        key: { orderNumber: 1 },
        options: {
            unique: true,
            name: 'unique_order_number_non_empty',
            partialFilterExpression: { orderNumber: { $type: 'string', $gt: '' } },
        },
        duplicateMatch: { orderNumber: { $type: 'string', $gt: '' } },
        duplicateGroupId: { orderNumber: '$orderNumber' },
    },
    {
        collection: 'orders',
        name: 'unique_user_idempotency_key',
        key: { userId: 1, idempotencyKey: 1 },
        options: { unique: true, sparse: true, name: 'unique_user_idempotency_key' },
        duplicateMatch: { idempotencyKey: { $exists: true, $ne: null } },
        duplicateGroupId: { userId: '$userId', idempotencyKey: '$idempotencyKey' },
    },
    {
        collection: 'orders',
        name: 'processing_orders_poll_v2',
        key: { status: 1, executionType: 1, providerCode: 1, providerOrderId: 1, lastCheckedAt: 1 },
        options: { name: 'processing_orders_poll_v2' },
    },
    {
        collection: 'googleoauthstates',
        name: 'unique_google_oauth_state_hash',
        key: { stateHash: 1 },
        options: { unique: true, name: 'unique_google_oauth_state_hash' },
        duplicateMatch: { stateHash: { $type: 'string', $gt: '' } },
        duplicateGroupId: { stateHash: '$stateHash' },
    },
    {
        collection: 'googleoauthstates',
        name: 'google_oauth_state_ttl',
        key: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, name: 'google_oauth_state_ttl' },
    },
    {
        collection: 'googleoauthstates',
        name: 'google_oauth_state_consume_lookup',
        key: { stateHash: 1, browserBindingHash: 1, consumedAt: 1, expiresAt: 1 },
        options: { name: 'google_oauth_state_consume_lookup' },
    },
    {
        collection: 'googleoauthlogincodes',
        name: 'unique_google_oauth_login_code_hash',
        key: { codeHash: 1 },
        options: { unique: true, name: 'unique_google_oauth_login_code_hash' },
        duplicateMatch: { codeHash: { $type: 'string', $gt: '' } },
        duplicateGroupId: { codeHash: '$codeHash' },
    },
    {
        collection: 'googleoauthlogincodes',
        name: 'google_oauth_login_code_ttl',
        key: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, name: 'google_oauth_login_code_ttl' },
    },
    {
        collection: 'googleoauthlogincodes',
        name: 'google_oauth_login_code_consume_lookup',
        key: { codeHash: 1, consumedAt: 1, expiresAt: 1 },
        options: { name: 'google_oauth_login_code_consume_lookup' },
    },
]);

const redactMongoUri = (uri = '') => {
    try {
        const parsed = new URL(uri);
        if (parsed.password) parsed.password = 'REDACTED';
        if (parsed.username) parsed.username = 'REDACTED';
        return parsed.toString();
    } catch {
        return 'REDACTED_OR_INVALID_URI';
    }
};

const resolveTargetUri = () => process.env.STAGING_MONGO_URI || '';

const assertStagingArgs = (args = process.argv.slice(2)) => {
    if (!args.includes('--staging')) {
        throw new Error('Refusing to run without explicit --staging flag.');
    }
    if (!args.includes('--check') && !args.includes('--apply')) {
        throw new Error('Use --check for dry-run or --apply to create missing indexes.');
    }
    if (args.includes('--apply') && args.includes('--check')) {
        throw new Error('Use either --check or --apply, not both.');
    }
};

const assertSafeDatabaseName = (databaseName) => {
    if (!databaseName) throw new Error('Could not determine target database name.');
    if (BLOCKING_DB_NAME_PATTERN.test(databaseName)) {
        throw new Error(`Refusing production-like database name: ${databaseName}`);
    }
};

const findDuplicateGroups = async (db, spec) => {
    if (!spec.duplicateGroupId) return [];
    const pipeline = [
        { $match: spec.duplicateMatch || {} },
        { $group: { _id: spec.duplicateGroupId, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 5 },
    ];
    return db.collection(spec.collection).aggregate(pipeline).toArray();
};

const summarizeIndex = async (db, spec, mode) => {
    const collection = db.collection(spec.collection);
    const existingIndexes = await collection.indexes().catch((error) => {
        if (error.codeName === 'NamespaceNotFound') return [];
        throw error;
    });
    const exists = existingIndexes.some((index) => index.name === spec.name);
    const duplicateGroups = await findDuplicateGroups(db, spec);
    const hasDuplicateBlocker = duplicateGroups.length > 0;

    if (mode === 'apply' && !exists && !hasDuplicateBlocker) {
        await collection.createIndex(spec.key, spec.options);
    }

    return {
        collection: spec.collection,
        index: spec.name,
        unique: Boolean(spec.options.unique),
        mode,
        exists,
        duplicateBlockers: duplicateGroups.length,
        action: exists
            ? 'NONE_ALREADY_EXISTS'
            : hasDuplicateBlocker
                ? 'BLOCKED_DUPLICATE_DATA'
                : mode === 'apply'
                    ? 'CREATED'
                    : 'WOULD_CREATE',
    };
};

const runStagingIndexRollout = async ({ mode }) => {
    const db = mongoose.connection.db;
    const databaseName = db.databaseName;
    assertSafeDatabaseName(databaseName);

    const results = [];
    for (const spec of INDEX_ROLLOUTS) {
        results.push(await summarizeIndex(db, spec, mode));
    }

    return {
        checkedAt: new Date().toISOString(),
        mode,
        targetDatabase: databaseName,
        credentialsPrinted: false,
        writesPerformed: mode === 'apply'
            ? results.filter((result) => result.action === 'CREATED').length
            : 0,
        duplicateBlockers: results.filter((result) => result.duplicateBlockers > 0),
        indexes: results,
    };
};

const main = async () => {
    const args = process.argv.slice(2);
    assertStagingArgs(args);

    const uri = resolveTargetUri();
    if (!uri) {
        console.log(JSON.stringify({
            success: false,
            code: 'NOT_RUN',
            message: 'STAGING_MONGO_URI is required. MONGO_URI is intentionally ignored by this staging rollout script.',
        }, null, 2));
        process.exitCode = 1;
        return;
    }

    const mode = args.includes('--apply') ? 'apply' : 'check';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    const result = await runStagingIndexRollout({ mode });
    console.log(JSON.stringify({
        ...result,
        targetUri: redactMongoUri(uri),
    }, null, 2));

    if (result.duplicateBlockers.length > 0) {
        process.exitCode = 1;
    }
};

if (require.main === module) {
    main()
        .catch((err) => {
            console.error(JSON.stringify({
                success: false,
                code: err.code || 'STAGING_INDEX_ROLLOUT_FAILED',
                message: err.message,
            }, null, 2));
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    INDEX_ROLLOUTS,
    assertStagingArgs,
    assertSafeDatabaseName,
    redactMongoUri,
    runStagingIndexRollout,
};
