'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);

const { ResellerApplication, RESELLER_APPLICATION_STATUS } = require('../src/modules/resellerApplications/resellerApplication.model');
const { User, RESELLER_STATUS } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');

const RESELLER_RECONCILIATION_CODES = Object.freeze({
    HEALTHY_PENDING: 'HEALTHY_PENDING',
    HEALTHY_APPROVED: 'HEALTHY_APPROVED',
    HEALTHY_REJECTED: 'HEALTHY_REJECTED',
    HEALTHY_SUSPENDED: 'HEALTHY_SUSPENDED',
    PENDING_WITH_APPROVED_USER: 'PENDING_WITH_APPROVED_USER',
    APPROVED_WITH_NON_APPROVED_USER: 'APPROVED_WITH_NON_APPROVED_USER',
    APPROVED_WITH_MISSING_GROUP: 'APPROVED_WITH_MISSING_GROUP',
    APPROVED_WITH_INACTIVE_GROUP: 'APPROVED_WITH_INACTIVE_GROUP',
    SUSPENDED_NOT_ON_DEFAULT_GROUP: 'SUSPENDED_NOT_ON_DEFAULT_GROUP',
    USER_APPROVED_WITHOUT_APPLICATION: 'USER_APPROVED_WITHOUT_APPLICATION',
    MULTIPLE_PENDING_APPLICATIONS: 'MULTIPLE_PENDING_APPLICATIONS',
    STATUS_HISTORY_MISMATCH: 'STATUS_HISTORY_MISMATCH',
    UNKNOWN: 'UNKNOWN',
});

const mongoUri = process.env.MONGO_URI || process.env.MONGO_TEST_URI;

const requireCheckFlag = () => {
    if (!process.argv.includes('--check')) {
        throw new Error('Refusing to connect without explicit --check flag.');
    }
};

const classifyResellerApplicationState = ({ application, user, assignedGroup, defaultGroup, pendingCount = 0 }) => {
    if (!application) {
        return user?.resellerStatus === RESELLER_STATUS.APPROVED
            ? RESELLER_RECONCILIATION_CODES.USER_APPROVED_WITHOUT_APPLICATION
            : RESELLER_RECONCILIATION_CODES.UNKNOWN;
    }

    if (pendingCount > 1) return RESELLER_RECONCILIATION_CODES.MULTIPLE_PENDING_APPLICATIONS;
    if (!user) return RESELLER_RECONCILIATION_CODES.UNKNOWN;

    if (application.status === RESELLER_APPLICATION_STATUS.PENDING) {
        return user.resellerStatus === RESELLER_STATUS.APPROVED
            ? RESELLER_RECONCILIATION_CODES.PENDING_WITH_APPROVED_USER
            : RESELLER_RECONCILIATION_CODES.HEALTHY_PENDING;
    }

    if (application.status === RESELLER_APPLICATION_STATUS.REJECTED) {
        return user.resellerStatus === RESELLER_STATUS.REJECTED
            ? RESELLER_RECONCILIATION_CODES.HEALTHY_REJECTED
            : RESELLER_RECONCILIATION_CODES.STATUS_HISTORY_MISMATCH;
    }

    if (application.status === RESELLER_APPLICATION_STATUS.APPROVED) {
        if (user.resellerStatus !== RESELLER_STATUS.APPROVED) {
            return RESELLER_RECONCILIATION_CODES.APPROVED_WITH_NON_APPROVED_USER;
        }
        if (!assignedGroup) return RESELLER_RECONCILIATION_CODES.APPROVED_WITH_MISSING_GROUP;
        if (assignedGroup.deletedAt || !assignedGroup.isActive) {
            return RESELLER_RECONCILIATION_CODES.APPROVED_WITH_INACTIVE_GROUP;
        }
        return String(user.groupId || '') === String(application.assignedGroupId || '')
            ? RESELLER_RECONCILIATION_CODES.HEALTHY_APPROVED
            : RESELLER_RECONCILIATION_CODES.STATUS_HISTORY_MISMATCH;
    }

    if (application.status === RESELLER_APPLICATION_STATUS.SUSPENDED) {
        if (user.resellerStatus !== RESELLER_STATUS.SUSPENDED) {
            return RESELLER_RECONCILIATION_CODES.STATUS_HISTORY_MISMATCH;
        }
        if (!defaultGroup || String(user.groupId || '') !== String(defaultGroup._id || '')) {
            return RESELLER_RECONCILIATION_CODES.SUSPENDED_NOT_ON_DEFAULT_GROUP;
        }
        return RESELLER_RECONCILIATION_CODES.HEALTHY_SUSPENDED;
    }

    return RESELLER_RECONCILIATION_CODES.UNKNOWN;
};

const run = async () => {
    requireCheckFlag();
    if (!mongoUri) {
        throw new Error('MONGO_URI is required for reseller application reconciliation preflight.');
    }

    await mongoose.connect(mongoUri);

    const applicationIdArg = process.argv.find((arg) => arg.startsWith('--application-id='));
    const filter = {};
    if (applicationIdArg) {
        const id = applicationIdArg.split('=').slice(1).join('=');
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new Error('--application-id must be a valid ObjectId.');
        }
        filter._id = new mongoose.Types.ObjectId(id);
    }

    const counts = Object.fromEntries(
        Object.values(RESELLER_RECONCILIATION_CODES).map((classification) => [classification, 0])
    );
    let totalApplicationsChecked = 0;

    const defaultGroups = await Group.find({ isDefault: true, deletedAt: null }).select('_id isDefault isActive deletedAt').limit(2).lean();
    const defaultGroup = defaultGroups.length === 1 && defaultGroups[0].isActive ? defaultGroups[0] : null;

    const cursor = ResellerApplication.find(filter)
        .select('_id userId status assignedGroupId')
        .lean()
        .cursor();

    for await (const application of cursor) {
        const [user, assignedGroup, pendingCount] = await Promise.all([
            User.findById(application.userId).select('_id resellerStatus groupId deletedAt status').lean(),
            application.assignedGroupId
                ? Group.findById(application.assignedGroupId).select('_id isActive deletedAt').lean()
                : null,
            application.status === RESELLER_APPLICATION_STATUS.PENDING
                ? ResellerApplication.countDocuments({ userId: application.userId, status: RESELLER_APPLICATION_STATUS.PENDING })
                : 0,
        ]);
        const classification = classifyResellerApplicationState({ application, user, assignedGroup, defaultGroup, pendingCount });
        counts[classification] = (counts[classification] || 0) + 1;
        totalApplicationsChecked += 1;
    }

    const approvedUsersWithoutApplication = await User.countDocuments({
        resellerStatus: RESELLER_STATUS.APPROVED,
        _id: { $nin: await ResellerApplication.distinct('userId', { status: RESELLER_APPLICATION_STATUS.APPROVED }) },
    });
    counts.USER_APPROVED_WITHOUT_APPLICATION += approvedUsersWithoutApplication;

    const blockingCount = Object.entries(counts)
        .filter(([classification]) => !classification.startsWith('HEALTHY_'))
        .reduce((sum, [, count]) => sum + count, 0);

    console.log(JSON.stringify({
        totalApplicationsChecked,
        classifications: counts,
        blockingCount,
        writesPerformed: 0,
    }, null, 2));

    if (blockingCount > 0) {
        throw new Error('Reseller application reconciliation preflight found blocking issues.');
    }
};

if (require.main === module) {
    run()
        .catch((err) => {
            console.error(`[resellerApplicationReconciliationPreflight] ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => {
            await mongoose.disconnect().catch(() => {});
        });
}

module.exports = {
    RESELLER_RECONCILIATION_CODES,
    classifyResellerApplicationState,
    run,
};
