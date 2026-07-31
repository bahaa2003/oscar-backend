'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config/config');

const transactionCapableTopologyTypes = new Set([
    'ReplicaSetWithPrimary',
    'Sharded',
    'LoadBalanced',
]);

const classifyTopology = ({ hello = {}, topologyType = 'Unknown' } = {}) => {
    const hasWritablePrimary = Boolean(hello.isWritablePrimary || hello.ismaster);
    const setName = hello.setName || null;
    const isMongos = topologyType === 'Sharded' || hello.msg === 'isdbgrid';
    const logicalSessionsEnabled = hello.logicalSessionTimeoutMinutes != null;
    const likelySupportsTransactions = transactionCapableTopologyTypes.has(topologyType)
        && (isMongos || topologyType !== 'ReplicaSetWithPrimary' || Boolean(setName))
        && hasWritablePrimary
        && logicalSessionsEnabled;

    let classification = 'UNKNOWN';
    if (isMongos) {
        classification = 'MONGOS_SHARDED';
    } else if (topologyType === 'ReplicaSetWithPrimary' || setName) {
        classification = 'REPLICA_SET';
    } else if (topologyType === 'Single') {
        classification = 'STANDALONE';
    }

    return {
        classification,
        topologyType,
        setName,
        hasWritablePrimary,
        logicalSessionsEnabled,
        maxWireVersion: hello.maxWireVersion ?? null,
        likelySupportsTransactions,
    };
};

const run = async () => {
    if (!process.argv.includes('--check')) {
        throw new Error('Refusing to connect without explicit --check flag.');
    }

    if (!config.db.uri) {
        throw new Error('MONGO_URI is required for topology preflight.');
    }

    await mongoose.connect(config.db.uri, {
        serverSelectionTimeoutMS: 5000,
    });

    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const topologyType = mongoose.connection.client.topology?.description?.type || 'Unknown';
    const result = {
        ok: Boolean(hello.ok),
        ...classifyTopology({ hello, topologyType }),
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.likelySupportsTransactions) {
        throw new Error(
            'MongoDB topology is not ready for financial transactions. Use a replica set or sharded cluster before Phase 2B transaction rollout.'
        );
    }
};

if (require.main === module) {
    run()
        .catch((err) => {
            console.error(`[financialTopologyPreflight] ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = { classifyTopology, run };
