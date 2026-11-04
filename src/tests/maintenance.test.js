'use strict';

const jwt = require('jsonwebtoken');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const { Setting } = require('../modules/admin/setting.model');
const { Order } = require('../modules/orders/order.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');

let server;
let baseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(clearCollections);

const request = async (path, user, method = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
};

test('only an authenticated active admin can change the persisted maintenance setting', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup();

    const initialStatus = await request('/api/maintenance/status');
    expect(initialStatus.body.data).toMatchObject({ enabled: false, canBypass: false });
    expect(initialStatus.headers.get('cache-control')).toContain('no-store');
    expect((await request('/api/maintenance/status', customer, 'PATCH', { enabled: true })).status).toBe(403);
    expect((await request('/api/maintenance/status', admin, 'PATCH', { enabled: 'true' })).status).toBe(400);

    const enabled = await request('/api/maintenance/status', admin, 'PATCH', { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.enabled).toBe(true);
    expect((await Setting.findOne({ key: 'maintenanceMode' }).lean()).value).toBe(true);
    expect((await request('/api/admin/settings/maintenanceMode', admin, 'PATCH', { value: 'true' })).status).toBe(400);
    expect((await request('/api/maintenance/status', admin)).body.data).toMatchObject({ enabled: true, canBypass: true });
    expect((await request('/api/maintenance/status', customer)).body.data).toMatchObject({ enabled: true, canBypass: false });

    expect((await request('/api/maintenance/status', admin, 'PATCH', { enabled: false })).body.data.enabled).toBe(false);
    expect((await request('/api/maintenance/status')).body.data.enabled).toBe(false);
});

test('maintenance returns 503 on storefront and customer APIs while auth and admin APIs stay available', async () => {
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup();
    await request('/api/maintenance/status', admin, 'PATCH', { enabled: true });

    await new Promise((resolve) => server.close(resolve));
    delete require.cache[require.resolve('../app')];
    server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    expect((await request('/api/maintenance/status')).body.data.enabled).toBe(true);

    const storefrontApi = await request('/api/categories');
    expect(storefrontApi.status).toBe(503);
    expect(storefrontApi.body.code).toBe('MAINTENANCE_MODE');

    const customerOrders = await request('/api/orders/my', customer);
    expect(customerOrders.status).toBe(503);
    expect(customerOrders.body.code).toBe('MAINTENANCE_MODE');

    const ordersBefore = await Order.countDocuments();
    const depositsBefore = await DepositRequest.countDocuments();
    expect((await request('/api/orders', customer, 'POST', {})).status).toBe(503);
    expect((await request('/api/deposits', customer, 'POST', {})).status).toBe(503);
    expect(await Order.countDocuments()).toBe(ordersBefore);
    expect(await DepositRequest.countDocuments()).toBe(depositsBefore);

    expect((await request('/api/admin/settings', admin)).status).toBe(200);
    expect((await request('/api/maintenance/status', customer, 'PATCH', { enabled: false })).status).toBe(403);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: customer.email, password: 'HashedPass@1' }),
    });
    expect(login.status).toBe(200);

    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: admin.email, password: 'AdminPass@1' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminSession = (await adminLogin.json()).data;
    const adminStatus = await fetch(`${baseUrl}/api/maintenance/status`, {
        headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    expect((await adminStatus.json()).data.canBypass).toBe(true);

    await request('/api/maintenance/status', admin, 'PATCH', { enabled: false });
    expect((await request('/api/categories')).status).toBe(200);
});

test('an administrator whose role was revoked cannot bypass maintenance with an old token', async () => {
    const admin = await createAdmin();
    await request('/api/maintenance/status', admin, 'PATCH', { enabled: true });
    await admin.constructor.updateOne({ _id: admin._id }, { $set: { role: 'CUSTOMER' } });

    expect((await request('/api/categories', admin)).body.code).toBe('MAINTENANCE_MODE');
    expect((await request('/api/maintenance/status', admin)).body.data.canBypass).toBe(false);
});
