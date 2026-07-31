'use strict';

const mongoose = require('mongoose');
const Group = require('./group.model');
const { User } = require('../users/user.model');
const { ConflictError, NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Case-insensitive name collision check. */
const _assertNameUnique = async (name, excludeId = null) => {
    const query = { name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } };
    if (excludeId) query._id = { $ne: excludeId };
    const existing = await Group.findOne(query);
    if (existing) throw new ConflictError(`A group named '${name}' already exists.`);
};

const _assertValidObjectId = (id, code = 'INVALID_GROUP_ID') => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new BusinessRuleError('Invalid group ID.', code);
    }
};

const _assertGroupCanBeDefault = (group) => {
    if (!group) throw new NotFoundError('Group');
    if (group.deletedAt) {
        throw new BusinessRuleError(
            `Group '${group.name}' is deleted and cannot be the default group.`,
            'DEFAULT_GROUP_DELETED'
        );
    }
    if (!group.isActive) {
        throw new BusinessRuleError(
            `Group '${group.name}' is inactive and cannot be the default group.`,
            'DEFAULT_GROUP_INACTIVE'
        );
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new pricing group.
 *
 * @param {{ name: string, percentage: number, billingMode?: 'standard'|'quantity_only' }} data
 */
const createGroup = async ({ name, percentage, billingMode, isActive = true, isDefault = false }) => {
    await _assertNameUnique(name);
    const normalizedBillingMode = billingMode || 'standard';
    if (!['standard', 'quantity_only'].includes(normalizedBillingMode)) {
        throw new BusinessRuleError('billingMode must be "standard" or "quantity_only".', 'INVALID_BILLING_MODE');
    }
    if (isDefault && !isActive) {
        throw new BusinessRuleError('Default group must be active.', 'DEFAULT_GROUP_INACTIVE');
    }
    const group = await Group.create({
        name: name.trim(),
        percentage,
        isActive,
        isDefault: false,
        billingMode: normalizedBillingMode,
    });
    if (!isDefault) return group;
    return setDefaultGroup(group._id);
};

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all groups, sorted by percentage descending.
 *
 * @param {{ includeInactive?: boolean }} opts
 */
const listGroups = async ({ includeInactive = false } = {}) => {
    const filter = { deletedAt: null };
    if (!includeInactive) filter.isActive = true;
    return Group.find(filter).sort({ percentage: -1, name: 1 });
};

/**
 * Get a single group by ID.
 */
const getGroupById = async (id) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');
    return group;
};

const getDefaultGroup = async () => {
    const defaults = await Group.find({ isDefault: true, deletedAt: null }).limit(2);

    if (defaults.length > 1) {
        throw new BusinessRuleError(
            'Multiple default pricing groups are configured. Please fix group settings.',
            'MULTIPLE_DEFAULT_GROUPS'
        );
    }

    if (defaults.length === 0) {
        throw new BusinessRuleError(
            'No default pricing group is configured. Please contact an administrator.',
            'DEFAULT_GROUP_NOT_CONFIGURED'
        );
    }

    const group = defaults[0];
    _assertGroupCanBeDefault(group);
    return group;
};

const validateDefaultGroup = async () => getDefaultGroup();

const setDefaultGroup = async (groupId) => {
    _assertValidObjectId(groupId);

    const session = await mongoose.startSession();
    let selectedGroup;

    try {
        await session.withTransaction(async () => {
            const group = await Group.findById(groupId).session(session);
            _assertGroupCanBeDefault(group);

            await Group.updateMany(
                { _id: { $ne: group._id }, isDefault: true },
                { $set: { isDefault: false } },
                { session }
            );

            group.isDefault = true;
            await group.save({ session });
            selectedGroup = group;
        });
    } catch (err) {
        if (err && err.code === 11000) {
            throw new ConflictError('A default pricing group is already configured.');
        }
        throw err;
    } finally {
        await session.endSession();
    }

    return selectedGroup;
};

/**
 * Return the active group with the highest percentage.
 * Called during user registration to auto-assign a tier.
 *
 * Throws BusinessRuleError (→ 422) when no active groups exist so that
 * the registration route returns a clear, actionable error.
 */
const getHighestPercentageGroup = async () => {
    const group = await Group.findOne({ isActive: true }).sort({ percentage: -1 }).limit(1);
    if (!group) {
        throw new BusinessRuleError(
            'No pricing groups are available. Please contact an administrator.',
            'NO_GROUPS_AVAILABLE'
        );
    }
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — GROUP FIELDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a group's markup percentage.
 *
 * IMPORTANT: Only affects future price calculations.
 * Existing orders are NEVER retroactively changed (unitPrice is snapshotted
 * at order creation time and lives on the Order document).
 *
 * @param {string} id           - Group ObjectId
 * @param {number} percentage   - New percentage value (>= 0)
 */
const updateGroupPercentage = async (id, percentage) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');

    if (percentage < 0) {
        throw new BusinessRuleError('Percentage cannot be negative.', 'INVALID_PERCENTAGE');
    }

    group.percentage = percentage;
    await group.save();
    return group;
};

/**
 * Update any editable fields on a group (name and/or percentage).
 * Name uniqueness is enforced case-insensitively.
 */
const updateGroup = async (id, { name, percentage, isActive, billingMode, isDefault }) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');

    const desiredIsActive = isActive !== undefined ? isActive : group.isActive;

    if (group.isDefault && isActive === false) {
        throw new BusinessRuleError(
            'The current default group cannot be deactivated until another default is selected.',
            'DEFAULT_GROUP_CANNOT_BE_DEACTIVATED'
        );
    }

    if (group.isDefault && isDefault === false) {
        throw new BusinessRuleError(
            'The current default group cannot be unset without selecting another default.',
            'DEFAULT_GROUP_REQUIRED'
        );
    }

    if (isDefault === true && !desiredIsActive) {
        throw new BusinessRuleError('Default group must be active.', 'DEFAULT_GROUP_INACTIVE');
    }

    if (name !== undefined) {
        await _assertNameUnique(name, id);
        group.name = name.trim();
    }

    if (percentage !== undefined) {
        if (percentage < 0) {
            throw new BusinessRuleError('Percentage cannot be negative.', 'INVALID_PERCENTAGE');
        }
        group.percentage = percentage;
    }

    if (isActive !== undefined) group.isActive = isActive;

    if (billingMode !== undefined) {
        if (!['standard', 'quantity_only'].includes(billingMode)) {
            throw new BusinessRuleError('billingMode must be "standard" or "quantity_only".', 'INVALID_BILLING_MODE');
        }
        group.billingMode = billingMode;
    }

    await group.save();

    if (isDefault === true) {
        return setDefaultGroup(group._id);
    }

    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soft-delete a group by setting deletedAt + isActive = false.
 * Throws NotFoundError if missing, BusinessRuleError if already deleted.
 */
const deleteGroup = async (id) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');
    if (group.deletedAt) throw new BusinessRuleError('Group is already deleted.', 'ALREADY_DELETED');
    if (group.isDefault) {
        throw new BusinessRuleError(
            'The current default group cannot be deleted until another default is selected.',
            'DEFAULT_GROUP_CANNOT_BE_DELETED'
        );
    }

    group.deletedAt = new Date();
    group.isActive = false;
    await group.save();
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — USER'S GROUP ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Move a user to a different pricing group.
 *
 * Rules:
 *  - Both the user and the target group must exist.
 *  - The target group must be active.
 *  - The change takes effect on the NEXT order; existing orders are unaffected.
 *
 * @param {string} userId   - User ObjectId
 * @param {string} groupId  - Target Group ObjectId
 * @returns {Promise<import('../users/user.model').User>} Updated user (safe)
 */
const changeUserGroup = async (userId, groupId) => {
    const [user, group] = await Promise.all([
        User.findById(userId).select('-password'),
        Group.findById(groupId),
    ]);

    if (!user) throw new NotFoundError('User');
    if (!group) throw new NotFoundError('Group');

    if (group.deletedAt) {
        throw new BusinessRuleError(
            `Group '${group.name}' is deleted and cannot be assigned to users.`,
            'GROUP_DELETED'
        );
    }

    if (!group.isActive) {
        throw new BusinessRuleError(
            `Group '${group.name}' is currently inactive and cannot be assigned to users.`,
            'GROUP_INACTIVE'
        );
    }

    user.groupId = group._id;
    await user.save();

    await user.populate('groupId', 'name percentage');
    return user;
};

module.exports = {
    createGroup,
    listGroups,
    getGroupById,
    getDefaultGroup,
    setDefaultGroup,
    validateDefaultGroup,
    getHighestPercentageGroup,
    updateGroupPercentage,
    updateGroup,
    deleteGroup,
    changeUserGroup,
};
