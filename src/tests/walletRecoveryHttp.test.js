'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { DepositCreditGuard } = require('../modules/deposits/depositCreditGuard.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');

let server;
let baseUrl;
let request;

beforeAll(async () => {
    await connectTestDB();
    server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    request = async (path, user, method = 'GET') => {
        const headers = {};
        if (user) headers.Authorization = `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`;
        const response = await fetch(`${baseUrl}${path}`, { method, headers });
        return { status: response.status, body: await response.json() };
    };
});

afterAll(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(clearCollections);

const createRecoveryDeposit = async (userId, { guardStatus = 'PREPARED', amount = 8, leaseUntil = null } = {}) => {
    const deposit = await DepositRequest.create({
        userId, paymentMethodId: 'test-bank', requestedAmount: amount, currency: 'USD', exchangeRate: 1,
        amountUsd: amount, receiptImage: 'uploads/deposits/http-recovery-test.jpg', status: 'CREDIT_PENDING',
        approvalCreditAmount: amount, approvalCreditCurrency: 'USD',
    });
    await DepositCreditGuard.create({
        idempotencyKey: `deposit:${deposit._id}:credit`, depositId: deposit._id, userId, amount, currency: 'USD',
        status: guardStatus, attempts: 0, leaseOwner: leaseUntil ? 'other-worker' : null,
        leaseToken: leaseUntil ? 'other-worker-token' : null, leaseUntil,
    });
    return deposit;
};

test('recovery issues endpoint authenticates and enforces MANAGE_WALLET over HTTP', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup();
    const supervisor = await User.create({
        name: 'Wallet supervisor', email: `wallet-supervisor-${Date.now()}@test.invalid`, password: 'Pass12345!',
        role: 'SUPERVISOR', status: USER_STATUS.ACTIVE, verified: true, groupId: customer.groupId,
        permissions: ['MANAGE_WALLET'],
    });
    expect((await request('/api/admin/wallet-operations/issues')).status).toBe(401);
    expect((await request('/api/admin/wallet-operations/issues', customer)).status).toBe(403);
    expect((await request('/api/admin/wallet-operations/issues', supervisor)).status).toBe(200);
    expect((await request('/api/admin/wallet-operations/issues', admin)).status).toBe(200);
});

test('admin wallet credit endpoint replays an idempotent request without crediting twice', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ walletBalance: -822.173, currency: 'EGP' });
    const path = `/api/admin/wallets/${customer._id}/add`;
    const idempotencyKey = 'admin-credit-http-retry-001';
    const sendCredit = async (user) => {
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
        if (user) headers.Authorization = `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`;
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST', headers,
            body: JSON.stringify({ amount: 800, reason: 'HTTP wallet credit verification', idempotencyKey }),
        });
        return { status: response.status, body: await response.json() };
    };

    expect((await sendCredit(null)).status).toBe(401);
    expect((await sendCredit(customer)).status).toBe(403);
    const first = await sendCredit(admin);
    const retry = await sendCredit(admin);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect((await User.findById(customer._id)).walletBalance).toBe(-22.17);
    expect(await WalletTransaction.countDocuments({ userId: customer._id, idempotencyKey })).toBe(1);
});

test('admin wallet credit treats a legacy null wallet reservation as unlocked', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ walletBalance: 25, currency: 'EGP' });
    // Some legacy documents explicitly stored the optional field as BSON null.
    await User.collection.updateOne({ _id: customer._id }, { $set: { activeWalletOperation: null } });

    const response = await fetch(`${baseUrl}/api/admin/wallets/${customer._id}/add`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET)}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'admin-credit-null-wallet-lock-001',
        },
        body: JSON.stringify({ amount: 800, reason: 'Legacy null lock regression', idempotencyKey: 'admin-credit-null-wallet-lock-001' }),
    });

    expect(response.status).toBe(201);
    expect((await User.findById(customer._id)).walletBalance).toBe(825);
    expect(await WalletTransaction.countDocuments({ userId: customer._id, idempotencyKey: 'admin-credit-null-wallet-lock-001' })).toBe(1);
});

test('deposit recovery requires MANAGE_DEPOSITS and a valid incomplete guard resumes through HTTP', async () => {
    const { customer } = await createCustomerWithGroup({ walletBalance: 20 });
    const walletOnlySupervisor = await User.create({
        name: 'Wallet only supervisor', email: `wallet-only-${Date.now()}@test.invalid`, password: 'Pass12345!',
        role: 'SUPERVISOR', status: USER_STATUS.ACTIVE, verified: true, groupId: customer.groupId,
        permissions: ['MANAGE_WALLET'],
    });
    const deposit = await createRecoveryDeposit(customer._id);
    const before = (await User.findById(customer._id)).walletBalance;
    const path = `/api/admin/wallet-operations/deposits/${deposit._id}/recover`;
    expect((await request(path, null, 'POST')).status).toBe(401);
    expect((await request(path, walletOnlySupervisor, 'POST')).status).toBe(403);

    const depositSupervisor = await User.create({
        name: 'Deposit supervisor', email: `deposit-supervisor-${Date.now()}@test.invalid`, password: 'Pass12345!',
        role: 'SUPERVISOR', status: USER_STATUS.ACTIVE, verified: true, groupId: customer.groupId,
        permissions: ['MANAGE_DEPOSITS'],
    });
    const response = await request(path, depositSupervisor, 'POST');
    expect(response.status).toBe(200);
    expect((await DepositRequest.findById(deposit._id)).status).toBe('APPROVED');
    expect((await User.findById(customer._id)).walletBalance).toBe(before + 8);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: `deposit:${deposit._id}:credit` })).toBe(1);
});

test('completed or unsafe/mismatched recovery states fail closed without changing the wallet', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ walletBalance: 17 });
    const completedDeposit = await DepositRequest.create({
        userId: customer._id, paymentMethodId: 'test-bank', requestedAmount: 4, currency: 'USD', exchangeRate: 1,
        amountUsd: 4, receiptImage: 'uploads/deposits/completed.jpg', status: 'APPROVED',
        approvalCreditAmount: 4, approvalCreditCurrency: 'USD',
    });
    await DepositCreditGuard.create({
        idempotencyKey: `deposit:${completedDeposit._id}:credit`, depositId: completedDeposit._id,
        userId: customer._id, amount: 4, currency: 'USD', status: 'COMPLETED',
    });
    const completedResponse = await request(`/api/admin/wallet-operations/deposits/${completedDeposit._id}/recover`, admin, 'POST');
    expect(completedResponse.status).toBe(422);

    const leasedDeposit = await createRecoveryDeposit(customer._id, { leaseUntil: new Date(Date.now() + 60_000) });
    const leasedResponse = await request(`/api/admin/wallet-operations/deposits/${leasedDeposit._id}/recover`, admin, 'POST');
    expect(leasedResponse.status).toBe(422);

    const mismatchDeposit = await createRecoveryDeposit(customer._id, { amount: 5 });
    await DepositRequest.updateOne({ _id: mismatchDeposit._id }, { $set: { approvalCreditAmount: 6 } });
    const mismatchResponse = await request(`/api/admin/wallet-operations/deposits/${mismatchDeposit._id}/recover`, admin, 'POST');
    expect(mismatchResponse.status).toBe(422);

    const failedDeposit = await createRecoveryDeposit(customer._id, { amount: 2, guardStatus: 'FAILED' });
    const failedResponse = await request(`/api/admin/wallet-operations/deposits/${failedDeposit._id}/recover`, admin, 'POST');
    expect(failedResponse.status).toBe(422);
    expect((await User.findById(customer._id)).walletBalance).toBe(17);
    expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
});

test('two concurrent authorized requests cannot apply the same deposit twice', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ walletBalance: 10 });
    const deposit = await createRecoveryDeposit(customer._id, { amount: 3 });
    const path = `/api/admin/wallet-operations/deposits/${deposit._id}/recover`;
    const [first, second] = await Promise.all([request(path, admin, 'POST'), request(path, admin, 'POST')]);
    expect([first.status, second.status].sort()).toEqual([200, 422]);
    expect((await User.findById(customer._id)).walletBalance).toBe(13);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: `deposit:${deposit._id}:credit` })).toBe(1);
    expect((await DepositRequest.findById(deposit._id)).status).toBe('APPROVED');
});
