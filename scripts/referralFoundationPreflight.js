'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const { User } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');

const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;

const countUsersPointingToGroups = async (matchGroup) => {
    const rows = await User.aggregate([
        { $match: { groupId: { $ne: null } } },
        {
            $lookup: {
                from: 'groups',
                localField: 'groupId',
                foreignField: '_id',
                as: 'group',
            },
        },
        { $unwind: { path: '$group', preserveNullAndEmptyArrays: true } },
        { $match: matchGroup },
        { $count: 'count' },
    ]);

    return rows[0]?.count || 0;
};

const main = async () => {
    if (!mongoUri) {
        console.error('MONGO_URI is required for preflight.');
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(mongoUri);

    const duplicateReferralCodes = await User.aggregate([
        { $match: { referralCode: { $type: 'string', $gt: '' } } },
        { $group: { _id: '$referralCode', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'duplicateCodeGroups' },
    ]);

    const [
        totalUsers,
        usersMissingReferralCode,
        usersMissingGroupId,
        usersPointingToMissingGroup,
        usersPointingToInactiveGroup,
        usersPointingToDeletedGroup,
        activeGroups,
        groupsMarkedDefault,
        validDefaultGroups,
        usersMissingResellerStatus,
    ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({
            $or: [
                { referralCode: { $exists: false } },
                { referralCode: null },
                { referralCode: '' },
            ],
        }),
        User.countDocuments({
            $or: [
                { groupId: { $exists: false } },
                { groupId: null },
            ],
        }),
        countUsersPointingToGroups({ group: { $eq: null } }),
        countUsersPointingToGroups({ 'group.isActive': false, 'group.deletedAt': null }),
        countUsersPointingToGroups({ 'group.deletedAt': { $ne: null } }),
        Group.countDocuments({ isActive: true, deletedAt: null }),
        Group.countDocuments({ isDefault: true }),
        Group.countDocuments({ isDefault: true, isActive: true, deletedAt: null }),
        User.countDocuments({
            $or: [
                { resellerStatus: { $exists: false } },
                { resellerStatus: null },
                { resellerStatus: '' },
            ],
        }),
    ]);

    const report = {
        totalUsers,
        usersMissingReferralCode,
        duplicateNonNullReferralCodeGroups: duplicateReferralCodes[0]?.duplicateCodeGroups || 0,
        usersMissingGroupId,
        usersPointingToMissingGroup,
        usersPointingToInactiveGroup,
        usersPointingToDeletedGroup,
        activeGroups,
        groupsMarkedDefault,
        validEffectiveDefaultGroupExists: validDefaultGroups === 1,
        validEffectiveDefaultGroupCount: validDefaultGroups,
        usersMissingResellerStatus,
    };

    console.log(JSON.stringify(report, null, 2));
};

main()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
