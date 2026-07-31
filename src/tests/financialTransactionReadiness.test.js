'use strict';

const mongoose = require('mongoose');
const { classifyTopology } = require('../../scripts/financialTopologyPreflight');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Mongo transaction readiness for financial Phase 2B', () => {
    it('test topology supports committing a wallet update inside a session', async () => {
        const group = await createGroup({ name: 'TxnReady', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 10 });
        const session = await mongoose.startSession();

        try {
            session.startTransaction();
            await User.updateOne(
                { _id: customer._id },
                { $inc: { walletBalance: 5 } },
                { session }
            );
            await session.commitTransaction();
        } finally {
            await session.endSession();
        }

        const fresh = await User.findById(customer._id);
        expect(fresh.walletBalance).toBe(15);
    });

    it('test topology supports rolling back a wallet update inside a session', async () => {
        const group = await createGroup({ name: 'TxnRollback', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 10 });
        const session = await mongoose.startSession();

        try {
            session.startTransaction();
            await User.updateOne(
                { _id: customer._id },
                { $inc: { walletBalance: 5 } },
                { session }
            );
            await session.abortTransaction();
        } finally {
            await session.endSession();
        }

        const fresh = await User.findById(customer._id);
        expect(fresh.walletBalance).toBe(10);
    });
});

describe('Production topology preflight classification', () => {
    it('classifies a writable replica set as transaction-capable', () => {
        expect(classifyTopology({
            topologyType: 'ReplicaSetWithPrimary',
            hello: {
                ok: 1,
                setName: 'rs0',
                isWritablePrimary: true,
                logicalSessionTimeoutMinutes: 30,
                maxWireVersion: 17,
            },
        })).toMatchObject({
            classification: 'REPLICA_SET',
            likelySupportsTransactions: true,
        });
    });

    it('classifies standalone MongoDB as not transaction-capable', () => {
        expect(classifyTopology({
            topologyType: 'Single',
            hello: {
                ok: 1,
                isWritablePrimary: true,
                logicalSessionTimeoutMinutes: 30,
            },
        })).toMatchObject({
            classification: 'STANDALONE',
            likelySupportsTransactions: false,
        });
    });

    it('classifies mongos as transaction-capable when sessions are available', () => {
        expect(classifyTopology({
            topologyType: 'Sharded',
            hello: {
                ok: 1,
                msg: 'isdbgrid',
                isWritablePrimary: true,
                logicalSessionTimeoutMinutes: 30,
            },
        })).toMatchObject({
            classification: 'MONGOS_SHARDED',
            likelySupportsTransactions: true,
        });
    });
});
