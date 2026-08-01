'use strict';

const mongoose = require('mongoose');
const groupService = require('../modules/groups/group.service');
const Group = require('../modules/groups/group.model');
const { User } = require('../modules/users/user.model');
const { register } = require('../modules/auth/auth.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
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

const uniqueEmail = () =>
    `default-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

describe('default group resolution', () => {
    it('resolves one active non-deleted explicit default group', async () => {
        const group = await groupService.createGroup({ name: 'Default', percentage: 0, isDefault: true });

        const resolved = await groupService.getDefaultGroup();

        expect(resolved._id.toString()).toBe(group._id.toString());
        expect(resolved.isDefault).toBe(true);
    });

    it('keeps explicit default resolution separate from highest Group registration', async () => {
        const defaultGroup = await groupService.createGroup({ name: 'Starter', percentage: 1, isDefault: true });
        const highestGroup = await groupService.createGroup({ name: 'Premium', percentage: 99 });

        const { user } = await register({
            name: 'Registered',
            email: uniqueEmail(),
            password: 'ValidPass@1',
        });

        const dbUser = await User.findById(user._id);
        expect((await groupService.getDefaultGroup())._id.toString()).toBe(defaultGroup._id.toString());
        expect(dbUser.groupId.toString()).toBe(highestGroup._id.toString());
    });

    it('fails clearly when no default group is configured', async () => {
        await groupService.createGroup({ name: 'Only', percentage: 10 });

        await expect(groupService.getDefaultGroup()).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_NOT_CONFIGURED',
        });
    });

    it('rejects an inactive default group', async () => {
        await Group.create({ name: 'Dormant', percentage: 10, isActive: false, isDefault: true });

        await expect(groupService.getDefaultGroup()).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_INACTIVE',
        });
    });

    it('rejects a deleted default group as missing effective default', async () => {
        await Group.create({
            name: 'Deleted',
            percentage: 10,
            isActive: true,
            isDefault: true,
            deletedAt: new Date(),
        });

        await expect(groupService.getDefaultGroup()).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_NOT_CONFIGURED',
        });
    });

    it('has a unique partial index for non-deleted default groups', async () => {
        await Group.syncIndexes();
        const indexes = await Group.collection.indexes();
        expect(indexes.some((index) => index.name === 'unique_non_deleted_default_group' && index.unique)).toBe(true);
    });
});

describe('default group switching and protection', () => {
    it('sets a new default and unsets the previous default safely', async () => {
        const first = await groupService.createGroup({ name: 'First', percentage: 1, isDefault: true });
        const second = await groupService.createGroup({ name: 'Second', percentage: 2 });

        await groupService.setDefaultGroup(second._id);

        const freshFirst = await Group.findById(first._id);
        const freshSecond = await Group.findById(second._id);
        expect(freshFirst.isDefault).toBe(false);
        expect(freshSecond.isDefault).toBe(true);
    });

    it('rejects setting an inactive group as default', async () => {
        const group = await Group.create({ name: 'Inactive', percentage: 1, isActive: false });

        await expect(groupService.setDefaultGroup(group._id)).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_INACTIVE',
        });
    });

    it('rejects setting a deleted group as default', async () => {
        const group = await Group.create({
            name: 'Deleted',
            percentage: 1,
            isActive: true,
            deletedAt: new Date(),
        });

        await expect(groupService.setDefaultGroup(group._id)).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_DELETED',
        });
    });

    it('rejects invalid default group ids', async () => {
        await expect(groupService.setDefaultGroup('not-an-id')).rejects.toMatchObject({
            code: 'INVALID_GROUP_ID',
        });
    });

    it('prevents deactivating the current default group', async () => {
        const group = await groupService.createGroup({ name: 'Default', percentage: 1, isDefault: true });

        await expect(groupService.updateGroup(group._id, { isActive: false })).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_CANNOT_BE_DEACTIVATED',
        });
    });

    it('prevents deleting the current default group', async () => {
        const group = await groupService.createGroup({ name: 'Default', percentage: 1, isDefault: true });

        await expect(groupService.deleteGroup(group._id)).rejects.toMatchObject({
            code: 'DEFAULT_GROUP_CANNOT_BE_DELETED',
        });
    });

    it('allows deactivating and deleting non-default groups with existing behavior preserved', async () => {
        await groupService.createGroup({ name: 'Default', percentage: 1, isDefault: true });
        const other = await groupService.createGroup({ name: 'Other', percentage: 2 });

        const inactive = await groupService.updateGroup(other._id, { isActive: false });
        expect(inactive.isActive).toBe(false);

        const deleted = await groupService.deleteGroup(other._id);
        expect(deleted.deletedAt).toBeInstanceOf(Date);
    });

    it('throws not found for a missing default target', async () => {
        await expect(groupService.setDefaultGroup(new mongoose.Types.ObjectId())).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });
});
