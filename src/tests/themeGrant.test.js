'use strict';

const jwt = require('jsonwebtoken');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const mongoose = require('mongoose');
const { connectTestDB, disconnectTestDB, clearCollections, createAdmin, createCustomerWithGroup } = require('./testHelpers');
const PlatformThemeGrant = require('../modules/theme/theme.grant.model');
const { ThemePayment, ThemeSubscription } = require('../modules/theme/subscription.model');
const { User } = require('../modules/users/user.model');
const theme = require('../modules/theme/theme.service');
const { preset } = require('../modules/theme/theme.validation');

let server, baseUrl;
beforeAll(async () => {
    await connectTestDB();
    server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(clearCollections);
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

const createGrant = (owner, overrides = {}) => PlatformThemeGrant.create({
    scopeKey: 'main', planId: 'THEME_ULTRA', grantedToUserId: owner._id, grantedByUserId: owner._id,
    reason: 'isolated test grant', status: 'ACTIVE',
    startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 7 * 86_400_000), ...overrides,
});
const auth = (user) => ({ Authorization: `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}` });

test('an existing owner grant enables ULTRA without creating payment/subscription or changing dates', async () => {
    expect(PlatformThemeGrant.collection.collectionName).toBe('platformthemegrants');
    const owner = await createAdmin();
    const grant = await createGrant(owner);
    const before = await PlatformThemeGrant.findById(grant._id).lean();
    expect((await theme.currentEntitlement()).isOwnerGrant).toBe(true);
    expect((await theme.getStatus()).eligibility).toMatchObject({ plan: 'THEME_ULTRA', canPublish: true,
        subscription: { status: 'ACTIVE', startsAt: before.startsAt, expiresAt: before.expiresAt } });
    for (const url of ['/api/admin/theme/settings', '/api/admin/theme/entitlement', '/api/admin/theme/subscription']) {
        const response = await fetch(`${baseUrl}${url}`, { headers: auth(owner) });
        expect(response.status).toBe(200);
        const { data } = await response.json();
        expect(data.eligibility).toMatchObject({ plan: 'THEME_ULTRA', canPublish: true,
            subscription: { status: 'ACTIVE', startsAt: before.startsAt.toISOString(), expiresAt: before.expiresAt.toISOString() } });
    }
    const customer = (await createCustomerWithGroup()).customer;
    expect((await fetch(`${baseUrl}/api/admin/theme/entitlement`, { headers: auth(customer) })).status).toBe(403);
    expect(await ThemePayment.countDocuments({})).toBe(0);
    expect(await ThemeSubscription.countDocuments({})).toBe(0);
    expect(await PlatformThemeGrant.countDocuments({})).toBe(1);
    expect(await PlatformThemeGrant.findById(grant._id).lean()).toEqual(before);
});

test('an active grant allows theme publication and a real image upload without modifying the grant', async () => {
    const owner = await createAdmin();
    const grant = await createGrant(owner);
    const before = await PlatformThemeGrant.findById(grant._id).lean();
    const config = preset('gold');
    config.brand.sidebarTemplate = 'royal';
    const response = await fetch(`${baseUrl}/api/admin/theme/publish`, { method: 'POST',
        headers: { ...auth(owner), 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.published.brand.sidebarTemplate).toBe('royal');
    const image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#123456' } }).png().toBuffer();
    const body = new FormData();
    body.append('image', new Blob([image], { type: 'image/png' }), 'isolated-theme-grant.png');
    const uploaded = await fetch(`${baseUrl}/api/admin/theme/media/upload`, { method: 'POST', headers: auth(owner), body });
    expect(uploaded.status).toBe(200);
    const uploadedPath = (await uploaded.json()).data.path;
    expect(uploadedPath).toMatch(/^\/uploads\/themes\/\d+-[a-f\d]{16}\.png$/);
    await fs.unlink(path.join(__dirname, '..', '..', uploadedPath));
    expect(await PlatformThemeGrant.findById(grant._id).lean()).toEqual(before);
    expect(await ThemePayment.countDocuments({})).toBe(0);
    expect(await ThemeSubscription.countDocuments({})).toBe(0);
});

test.each([
    ['expired', { expiresAt: new Date(Date.now() - 1) }],
    ['not yet started', { startsAt: new Date(Date.now() + 86_400_000), expiresAt: new Date(Date.now() + 2 * 86_400_000) }],
    ['revoked', { status: 'REVOKED', revokedAt: new Date() }],
    ['inconsistent active revocation', { revokedAt: new Date() }],
])('a %s grant is never treated as active and remains unchanged', async (_label, overrides) => {
    const owner = await createAdmin();
    const grant = await createGrant(owner, overrides);
    const before = await PlatformThemeGrant.findById(grant._id).lean();
    expect(await theme.currentEntitlement()).toBeNull();
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
    expect(await PlatformThemeGrant.findById(grant._id).lean()).toEqual(before);
});

test('a grant cannot turn a customer or an inactive or missing owner into an active platform grant', async () => {
    const owner = await createAdmin();
    const grant = await createGrant(owner);
    await User.updateOne({ _id: owner._id }, { $set: { role: 'CUSTOMER' } });
    expect(await theme.currentEntitlement()).toBeNull();
    await User.updateOne({ _id: owner._id }, { $set: { role: 'ADMIN', status: 'REJECTED' } });
    expect(await theme.currentEntitlement()).toBeNull();
    await User.updateOne({ _id: owner._id }, { $set: { status: 'ACTIVE' } });
    expect((await theme.currentEntitlement()).planId).toBe('THEME_ULTRA');
    await User.updateOne({ _id: owner._id }, { $set: { role: 'CUSTOMER' } });
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
    expect(await PlatformThemeGrant.findById(grant._id)).not.toBeNull();
});

test('a missing owner reference cannot enable ULTRA or create a grant', async () => {
    const owner = await createAdmin();
    await createGrant(owner, { grantedToUserId: new mongoose.Types.ObjectId() });
    expect(await theme.currentEntitlement()).toBeNull();
    expect(await PlatformThemeGrant.countDocuments({})).toBe(1);
});

test('changing or removing the activation script owner variable does not alter an existing grant', async () => {
    const owner = await createAdmin();
    const grant = await createGrant(owner);
    const before = await PlatformThemeGrant.findById(grant._id).lean();
    const original = process.env.THEME_GRANT_OWNER_ID;
    try {
        process.env.THEME_GRANT_OWNER_ID = new mongoose.Types.ObjectId().toString();
        expect((await theme.currentEntitlement()).planId).toBe('THEME_ULTRA');
        delete process.env.THEME_GRANT_OWNER_ID;
        expect((await theme.currentEntitlement()).planId).toBe('THEME_ULTRA');
        expect(await PlatformThemeGrant.findById(grant._id).lean()).toEqual(before);
    } finally {
        if (original === undefined) delete process.env.THEME_GRANT_OWNER_ID;
        else process.env.THEME_GRANT_OWNER_ID = original;
    }
});
