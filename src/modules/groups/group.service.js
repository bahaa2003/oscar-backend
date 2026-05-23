'use strict';

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

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new pricing group.
 *
 * @param {{ name: string, percentage: number, billingMode?: 'standard'|'quantity_only' }} data
 */
const createGroup = async ({ name, percentage, billingMode }) => {
    await _assertNameUnique(name);
    const normalizedBillingMode = billingMode || 'standard';
    if (!['standard', 'quantity_only'].includes(normalizedBillingMode)) {
        throw new BusinessRuleError('billingMode must be "standard" or "quantity_only".', 'INVALID_BILLING_MODE');
    }
    const group = await Group.create({
        name: name.trim(),
        percentage,
        billingMode: normalizedBillingMode,
    });
    return group;
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
const updateGroup = async (id, { name, percentage, isActive, billingMode }) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');

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
    getHighestPercentageGroup,
    updateGroupPercentage,
    updateGroup,
    deleteGroup,
    changeUserGroup,
};
