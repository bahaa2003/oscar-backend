'use strict';

const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { User, ROLES, USER_STATUS, RESELLER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
} = require('./testHelpers');

const execFileAsync = promisify(execFile);
const preflightScript = path.join(__dirname, '../../scripts/referralFoundationPreflight.js');
const backfillScript = path.join(__dirname, '../../scripts/backfillReferralFoundation.js');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const runNodeScript = async (script, args = []) => {
    const env = {
        ...process.env,
        MONGO_URI: process.env.MONGO_TEST_URI,
    };

    return execFileAsync(process.execPath, [script, ...args], {
        cwd: path.join(__dirname, '../..'),
        env,
        maxBuffer: 1024 * 1024,
    });
};

const createLegacyUser = async (overrides = {}) => {
    return User.collection.insertOne({
        name: 'Legacy User',
        email: `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
        role: ROLES.CUSTOMER,
        status: USER_STATUS.ACTIVE,
        verified: true,
        walletBalance: 0,
        creditLimit: 0,
        creditUsed: 0,
        currency: 'USD',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    });
};

describe('referral foundation preflight script', () => {
    it('reports aggregate counts without exposing PII', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        await createLegacyUser({ email: 'private-user@test.com', groupId: group._id });

        const { stdout } = await runNodeScript(preflightScript);
        const report = JSON.parse(stdout);

        expect(report.totalUsers).toBe(1);
        expect(report.usersMissingReferralCode).toBe(1);
        expect(report.usersMissingResellerStatus).toBe(1);
        expect(report.validEffectiveDefaultGroupExists).toBe(true);
        expect(stdout).not.toContain('private-user@test.com');
        expect(stdout).not.toContain('Legacy User');
    });
});

describe('referral foundation backfill script', () => {
    it('dry-run performs no writes', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const inserted = await createLegacyUser({ groupId: group._id });

        const { stdout } = await runNodeScript(backfillScript, ['--dry-run']);
        const report = JSON.parse(stdout);
        const fresh = await User.collection.findOne({ _id: inserted.insertedId });

        expect(report.mode).toBe('dry-run');
        expect(report.missingReferralCodes).toBe(1);
        expect(fresh.referralCode).toBeUndefined();
        expect(fresh.resellerStatus).toBeUndefined();
    });

    it('applies missing referral codes, reseller status, and explicit default group only where missing', async () => {
        const defaultGroup = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        const existingGroup = await createGroup({ name: 'Existing', percentage: 5 });
        const missingAll = await createLegacyUser();
        const existing = await createLegacyUser({
            groupId: existingGroup._id,
            referralCode: 'EXISTING22',
            resellerStatus: RESELLER_STATUS.APPROVED,
        });

        const { stdout } = await runNodeScript(backfillScript, [
            '--apply',
            `--default-group-id=${defaultGroup._id}`,
            '--batch-size=1',
        ]);
        const report = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop());
        const freshMissingAll = await User.findById(missingAll.insertedId);
        const freshExisting = await User.findById(existing.insertedId);

        expect(report.mode).toBe('apply');
        expect(freshMissingAll.referralCode).toMatch(/^[A-Z2-9]{10}$/);
        expect(freshMissingAll.resellerStatus).toBe(RESELLER_STATUS.NONE);
        expect(freshMissingAll.groupId.toString()).toBe(defaultGroup._id.toString());
        expect(freshExisting.referralCode).toBe('EXISTING22');
        expect(freshExisting.resellerStatus).toBe(RESELLER_STATUS.APPROVED);
        expect(freshExisting.groupId.toString()).toBe(existingGroup._id.toString());
    });

    it('rejects invalid, inactive, or deleted default group arguments', async () => {
        const inactive = await Group.create({ name: 'Inactive', percentage: 0, isActive: false, isDefault: false });

        await expect(runNodeScript(backfillScript, [
            '--apply',
            `--default-group-id=${inactive._id}`,
        ])).rejects.toMatchObject({
            stderr: expect.stringContaining('inactive'),
        });
    });

    it('stops when duplicate existing referral codes require manual review', async () => {
        await User.collection.dropIndex('unique_referral_code').catch(() => {});
        const group = await createGroup({ name: 'Default', percentage: 0, isDefault: true });
        await createLegacyUser({ groupId: group._id, referralCode: 'DUPLICATE2' });
        await createLegacyUser({ groupId: group._id, referralCode: 'DUPLICATE2' });

        await expect(runNodeScript(backfillScript, ['--dry-run'])).rejects.toMatchObject({
            stderr: expect.stringContaining('duplicate referral code'),
        });
    });
});
