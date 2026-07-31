'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const { User, RESELLER_STATUS } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');
const { assignMissingReferralCode } = require('../src/modules/referrals/referralCode.service');

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const getArg = (name) => {
    const prefix = `${name}=`;
    const found = args.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
};

const apply = hasFlag('--apply');
const dryRun = hasFlag('--dry-run') || !apply;
const defaultGroupId = getArg('--default-group-id');
const batchSize = Math.min(Math.max(Number(getArg('--batch-size')) || 100, 1), 500);
const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;

const missingReferralCodeFilter = {
    $or: [
        { referralCode: { $exists: false } },
        { referralCode: null },
        { referralCode: '' },
    ],
};

const missingGroupIdFilter = {
    $or: [
        { groupId: { $exists: false } },
        { groupId: null },
    ],
};

const missingResellerStatusFilter = {
    $or: [
        { resellerStatus: { $exists: false } },
        { resellerStatus: null },
        { resellerStatus: '' },
    ],
};

const countDuplicateReferralCodeGroups = async () => {
    const rows = await User.aggregate([
        { $match: { referralCode: { $type: 'string', $gt: '' } } },
        { $group: { _id: '$referralCode', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'count' },
    ]);
    return rows[0]?.count || 0;
};

const loadValidDefaultGroup = async () => {
    if (!defaultGroupId) return null;
    if (!mongoose.Types.ObjectId.isValid(defaultGroupId)) {
        throw new Error('--default-group-id must be a valid ObjectId.');
    }

    const group = await Group.findById(defaultGroupId);
    if (!group) throw new Error('The provided default group does not exist.');
    if (group.deletedAt) throw new Error('The provided default group is deleted.');
    if (!group.isActive) throw new Error('The provided default group is inactive.');
    if (!group.isDefault) throw new Error('The provided default group is not marked as default.');
    return group;
};

const updateUsersInBatches = async (filter, updateFactory) => {
    let scanned = 0;
    let modified = 0;

    while (true) {
        const users = await User.find(filter).select('_id').limit(batchSize).lean();
        if (users.length === 0) break;

        for (const user of users) {
            const update = updateFactory(user);
            const result = await User.updateOne({ _id: user._id, ...filter }, update, { runValidators: true });
            scanned += 1;
            modified += result.modifiedCount;
        }
    }

    return { scanned, modified };
};

const main = async () => {
    if (!mongoUri) {
        throw new Error('MONGO_URI is required for backfill.');
    }

    await mongoose.connect(mongoUri);

    const duplicateCodeGroups = await countDuplicateReferralCodeGroups();
    if (duplicateCodeGroups > 0) {
        throw new Error(`Unsafe precondition: ${duplicateCodeGroups} duplicate referral code group(s) require manual review.`);
    }

    const [missingReferralCodes, missingResellerStatuses, missingGroupIds] = await Promise.all([
        User.countDocuments(missingReferralCodeFilter),
        User.countDocuments(missingResellerStatusFilter),
        User.countDocuments(missingGroupIdFilter),
    ]);

    const defaultGroup = await loadValidDefaultGroup();
    if (apply && missingGroupIds > 0 && !defaultGroup) {
        throw new Error('Users missing groupId require --default-group-id=<ID> for apply mode.');
    }

    const summary = {
        mode: dryRun ? 'dry-run' : 'apply',
        batchSize,
        missingReferralCodes,
        missingResellerStatuses,
        missingGroupIds,
        defaultGroupId: defaultGroup ? String(defaultGroup._id) : null,
        referralCodesGenerated: 0,
        resellerStatusesSet: 0,
        groupIdsSet: 0,
    };

    if (dryRun) {
        console.log(JSON.stringify(summary));
        return;
    }

    const usersNeedingCodes = await User.find(missingReferralCodeFilter).select('_id').cursor({ batchSize });
    for await (const user of usersNeedingCodes) {
        const result = await assignMissingReferralCode(user._id, { User });
        if (result.modified) summary.referralCodesGenerated += 1;
        if (summary.referralCodesGenerated % batchSize === 0) {
            console.log(JSON.stringify({ progress: summary.referralCodesGenerated }));
        }
    }

    const resellerResult = await updateUsersInBatches(
        missingResellerStatusFilter,
        () => ({ $set: { resellerStatus: RESELLER_STATUS.NONE } })
    );
    summary.resellerStatusesSet = resellerResult.modified;

    if (defaultGroup) {
        const groupResult = await updateUsersInBatches(
            missingGroupIdFilter,
            () => ({ $set: { groupId: defaultGroup._id } })
        );
        summary.groupIdsSet = groupResult.modified;
    }

    console.log(JSON.stringify(summary));
};

main()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
