'use strict';

const { User, ROLES, USER_STATUS } = require('./user.model');
const Group = require('../groups/group.model');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { USER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { notifyAccountApproved } = require('../notifications/notification.service');

/** Shared populate projection for group fields shown in user responses. */
const GROUP_PROJECTION = 'name percentage isActive billingMode';

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: QUERIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: List all users with optional filters.
 * Supports filtering by role, status, groupId.
 */
const listUsers = async ({ page = 1, limit = 20, role, status, groupId } = {}) => {
    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (groupId) filter.groupId = groupId;

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('groupId', GROUP_PROJECTION),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Admin: Get a user by ID.
 */
const getUserById = async (id) => {
    const user = await User.findById(id)
        .select('-password')
        .populate('groupId', GROUP_PROJECTION);
    if (!user) throw new NotFoundError('User');
    return user;
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: ACTIVATION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Approve a user account.
 *
 * @param {string|ObjectId} targetUserId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext] - from req.auditContext (optional)
 */
const approveUser = async (targetUserId, adminId, auditContext = null) => {
    const user = await User.findById(targetUserId).select('-password');
    if (!user) throw new NotFoundError('User');

    if (user.status === USER_STATUS.ACTIVE) {
        throw new BusinessRuleError(
            'This account is already active.',
            'ALREADY_ACTIVE'
        );
    }

    const previousStatus = user.status;

    // Use findByIdAndUpdate to guarantee all fields are written to the DB,
    // including select:false fields (emailVerificationToken, emailVerificationExpires)
    // that are NOT loaded on the Mongoose document and would be silently skipped by .save().
    const updatedUser = await User.findByIdAndUpdate(
        targetUserId,
        {
            $set: {
                status: USER_STATUS.ACTIVE,
                verified: true,
                approvedBy: adminId,
                approvedAt: new Date(),
            },
            $unset: {
                emailVerificationToken: '',
                emailVerificationExpires: '',
                rejectedBy: '',
                rejectedAt: '',
            },
        },
        { new: true }
    ).select('-password');

    // ── Audit: fire-and-forget, after successful save ──────────────────────────
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: USER_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.USER,
        entityId: targetUserId,
        metadata: { previousStatus, approvedBy: adminId },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    // Notification: fire-and-forget
    notifyAccountApproved(targetUserId);

    return updatedUser.toSafeObject ? updatedUser.toSafeObject() : updatedUser.toObject();
};

/**
 * Admin: Reject a user account.
 *
 * @param {string|ObjectId} targetUserId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext] - from req.auditContext (optional)
 */
const rejectUser = async (targetUserId, adminId, auditContext = null) => {
    const user = await User.findById(targetUserId).select('-password');
    if (!user) throw new NotFoundError('User');

    if (user.status === USER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This account is already rejected.',
            'ALREADY_REJECTED'
        );
    }

    const previousStatus = user.status;

    user.status = USER_STATUS.REJECTED;
    user.rejectedBy = adminId;
    user.rejectedAt = new Date();
    user.approvedBy = null;
    user.approvedAt = null;

    await user.save();

    // ── Audit: fire-and-forget, after successful save ──────────────────────────
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: USER_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.USER,
        entityId: targetUserId,
        metadata: { previousStatus, rejectedBy: adminId },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return user.toSafeObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GENERAL UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Update user fields (credit limit, name, groupId).
 * Activation lifecycle is intentionally handled via approveUser/rejectUser
 * so that all audit fields (approvedBy/At, rejectedBy/At) are always set correctly.
 */
const updateUser = async (id, { groupId, creditLimit, name, quantityLimit }) => {
    const user = await User.findById(id);
    if (!user) throw new NotFoundError('User');

    if (groupId !== undefined) {
        if (groupId !== null) {
            const group = await Group.findById(groupId);
            if (!group) throw new NotFoundError('Group');
            if (!group.isActive) {
                throw new BusinessRuleError(
                    `Group '${group.name}' is inactive and cannot be assigned.`,
                    'GROUP_INACTIVE'
                );
            }
        }
        user.groupId = groupId;
    }

    if (creditLimit !== undefined) {
        if (creditLimit < 0) throw new BusinessRuleError('Credit limit cannot be negative.', 'INVALID_CREDIT_LIMIT');
        user.creditLimit = creditLimit;
    }

    if (quantityLimit !== undefined) {
        if (quantityLimit < 0) throw new BusinessRuleError('Quantity limit cannot be negative.', 'INVALID_QUANTITY_LIMIT');
        user.quantityLimit = quantityLimit;
    }

    if (name !== undefined) user.name = name;

    await user.save();
    return user.toSafeObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER: SELF-SERVICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Customer: Get own profile.
 */
const getMyProfile = async (userId) => {
    const user = await User.findById(userId)
        .select('-password')
        .populate('groupId', GROUP_PROJECTION);
    if (!user) throw new NotFoundError('User');
    return user;
};

/**
 * Customer: Update own profile (self-service).
 * Only allows safe fields: name, email, phone, username, password.
 */
const updateMyProfile = async (userId, { name, email, phone, username, password }) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (username !== undefined) user.username = username;

    if (password) {
        // The User model's pre-save hook should hash the password
        user.password = password;
    }

    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

/**
 * Customer: Update own avatar (self-service).
 * Accepts a URL string or null/empty to clear.
 */
const updateMyAvatar = async (userId, avatar) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    user.avatar = avatar || null;
    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: QUANTITY-ONLY BILLING MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Reset a user's quantityUsed to 0 after offline settlement.
 * Does NOT modify wallet/credit fields.
 *
 * @param {string|ObjectId} userId
 */
const resetQuantityUsed = async (userId) => {
    const user = await User.findById(userId).select('-password');
    if (!user) throw new NotFoundError('User');
    user.quantityUsed = 0;
    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

/**
 * Admin: Update a user's quantityLimit.
 * Does NOT modify wallet/credit fields.
 *
 * @param {string|ObjectId} userId
 * @param {number} quantityLimit
 */
const updateQuantityLimit = async (userId, quantityLimit) => {
    const user = await User.findById(userId).select('-password');
    if (!user) throw new NotFoundError('User');
    if (quantityLimit < 0) throw new BusinessRuleError('Quantity limit cannot be negative.', 'INVALID_QUANTITY_LIMIT');
    user.quantityLimit = quantityLimit;
    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

module.exports = {
    listUsers,
    getUserById,
    approveUser,
    rejectUser,
    updateUser,
    getMyProfile,
    updateMyProfile,
    updateMyAvatar,
    resetQuantityUsed,
    updateQuantityLimit,
};
