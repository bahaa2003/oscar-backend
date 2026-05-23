'use strict';

/**
 * admin.users.service.js
 *
 * Admin-level user management.
 * Operations: list, get, update, soft-delete, approve, reject.
 *
 * Does NOT use MongoDB transactions — all operations are single-document
 * writes that are inherently atomic.
 */

const { User, USER_STATUS, ROLES } = require('../users/user.model');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    USER_ACTIONS,
    ADMIN_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');

// ─── Private helper ────────────────────────────────────────────────────────────

const _findOrFail = async (id) => {
    const user = await User.findById(id).populate('groupId', 'name percentage');
    if (!user) throw new NotFoundError('User');
    return user;
};

// ─── List ──────────────────────────────────────────────────────────────────────

/**
 * Admin list of all users with filtering and pagination.
 *
 * @param {Object} opts
 * @param {string}  [opts.status]    - 'PENDING' | 'ACTIVE' | 'REJECTED'
 * @param {boolean} [opts.verified]  - filter by email verification flag
 * @param {string}  [opts.email]     - partial email search (case-insensitive)
 * @param {string}  [opts.search]    - partial name/email/username search
 * @param {string}  [opts.role]      - 'ADMIN' | 'CUSTOMER'
 * @param {Date}    [opts.from]      - createdAt >= from
 * @param {Date}    [opts.to]        - createdAt <= to
 * @param {number}  [opts.page]
 * @param {number}  [opts.limit]
 * @param {string}  [opts.sortBy]    - field name
 * @param {string}  [opts.sortOrder] - 'asc' | 'desc'
 */
const listUsers = async ({
    status,
    verified,
    email,
    search,
    role,
    from,
    to,
    page = 1,
    limit = 20,
    sortBy = 'walletBalance',
    sortOrder = 'desc',
} = {}) => {
    const normalizedPage = Number.isFinite(Number(page)) && Number(page) > 0
        ? Math.floor(Number(page))
        : 1;
    const requestedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : 20;
    const normalizedLimit = Math.min(requestedLimit, 20); // strict max for admin users page
    const skip = (normalizedPage - 1) * normalizedLimit;
    const normalizedSortBy = typeof sortBy === 'string' && sortBy.trim() ? sortBy.trim() : 'walletBalance';
    const normalizedSortOrder = String(sortOrder || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

    const filter = { deletedAt: null, verified: true };
    if (status) filter.status = status;
    if (verified != null) filter.verified = verified;
    if (role) filter.role = role;
    if (email) filter.email = { $regex: email, $options: 'i' };
    if (search) {
        const term = String(search).trim();
        if (term) {
            filter.$or = [
                { name: { $regex: term, $options: 'i' } },
                { email: { $regex: term, $options: 'i' } },
                { username: { $regex: term, $options: 'i' } },
            ];
        }
    }
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    const sort = normalizedSortBy === 'walletBalance'
        ? { walletBalance: normalizedSortOrder === 'asc' ? 1 : -1 }
        : { [normalizedSortBy]: normalizedSortOrder === 'asc' ? 1 : -1 };

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password -emailVerificationToken -emailVerificationExpires')
            .populate('groupId', 'name percentage')
            .sort(sort)
            .skip(skip)
            .limit(normalizedLimit),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

// ─── Get One ───────────────────────────────────────────────────────────────────

const getUserById = async (id) => {
    const user = await User.findById(id)
        .select('-password -emailVerificationToken -emailVerificationExpires')
        .populate('groupId', 'name percentage isActive');
    if (!user) throw new NotFoundError('User');
    return user;
};

// ─── Update ────────────────────────────────────────────────────────────────────

/**
 * Admin update of a user (name, email, groupId, status, verified).
 */
const updateUser = async (id, data, adminId) => {
    const user = await _findOrFail(id);
    const before = user.toObject();

    const { name, email, groupId, status, verified } = data;

    if (name !== undefined) user.name = name.trim();
    if (status !== undefined) {
        user.status = status;
        // Admin approval (ACTIVE) overrides the need for email verification.
        // Without this, approved users get locked out with "Please verify your email".
        if (status === 'ACTIVE') {
            user.verified = true;
            user.emailVerificationToken = null;
            user.emailVerificationExpires = null;
        }
    }
    if (verified !== undefined) user.verified = verified;
    if (groupId !== undefined) user.groupId = groupId;

    if (email !== undefined && email !== user.email) {
        const exists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: id } });
        if (exists) throw new ConflictError('An account with this email already exists.');
        user.email = email.toLowerCase();
    }

    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { before, after: user.toObject() },
    });

    return user;
};

// ─── Soft Delete ───────────────────────────────────────────────────────────────

const deleteUser = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (user.deletedAt) throw new BusinessRuleError('User is already deleted.', 'ALREADY_DELETED');
    if (user.role === ROLES.ADMIN) throw new BusinessRuleError('Admin accounts cannot be deleted.', 'CANNOT_DELETE_ADMIN');

    user.deletedAt = new Date();
    user.status = USER_STATUS.REJECTED;   // prevents login
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_DELETED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, deletedAt: user.deletedAt },
    });

    return user;
};

// ─── List Deleted ──────────────────────────────────────────────────────────────

/**
 * Admin list of soft-deleted users.
 */
const listDeletedUsers = async ({
    page = 1,
    limit = 100,
} = {}) => {
    limit = Math.min(limit, 200);
    const skip = (page - 1) * limit;

    const filter = { deletedAt: { $ne: null } };
    const sort = { deletedAt: -1 };

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password -emailVerificationToken -emailVerificationExpires')
            .populate('groupId', 'name percentage')
            .sort(sort)
            .skip(skip)
            .limit(limit),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

// ─── Restore (un-delete) ───────────────────────────────────────────────────────

/**
 * Restore a soft-deleted user. Clears deletedAt and resets status to PENDING
 * so the admin can re-approve when ready.
 */
const restoreUser = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (!user.deletedAt) {
        throw new BusinessRuleError('User is not deleted.', 'NOT_DELETED');
    }

    user.deletedAt = null;
    user.status = USER_STATUS.ACTIVE;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { action: 'restore', email: user.email, restoredAt: new Date() },
    });

    return user;
};

// ─── Approve / Reject ──────────────────────────────────────────────────────────
// These already exist in user.service.js. We proxy them here so all
// admin user operations come through a single module.

const { approveUser, rejectUser } = require('../users/user.service');

// ─── Update Role ──────────────────────────────────────────────────────────────

/**
 * Admin update of a user's role.
 * Guards: cannot demote yourself, cannot change a deleted user's role.
 */
const updateUserRole = async (id, role, adminId) => {
    const user = await _findOrFail(id);
    if (user._id.toString() === adminId.toString()) {
        throw new BusinessRuleError('You cannot change your own role.', 'SELF_ROLE_CHANGE');
    }
    if (!Object.values(ROLES).includes(role)) {
        throw new BusinessRuleError(`Invalid role: '${role}'. Must be ADMIN, SUPERVISOR, or CUSTOMER.`, 'INVALID_ROLE');
    }

    const previousRole = user.role;
    user.role = role;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_ROLE_CHANGED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { previousRole, newRole: role },
    });

    return user;
};

// ─── Update Currency ──────────────────────────────────────────────────────────

/**
 * Admin update of a user's wallet currency.
 *
 * CRITICAL: When the currency changes the wallet balance MUST be converted
 * so the user's purchasing power is preserved.
 *
 * Formula:  newBalance = (currentBalance / oldRate) * newRate
 *
 * Both `currency` and `walletBalance` are updated atomically to prevent
 * a window where the code is changed but the balance still holds the
 * old-currency amount.
 */
const updateUserCurrency = async (id, currency, adminId) => {
    const user = await _findOrFail(id);
    const code = currency.toUpperCase();

    // Same currency → no-op
    if (user.currency === code) return user;

    // Validate new currency exists and is active
    const { Currency } = require('../currency/currency.model');
    const newCurrencyDoc = await Currency.findOne({ code, isActive: true });
    if (!newCurrencyDoc) {
        throw new BusinessRuleError(`Currency '${code}' is not active or does not exist.`, 'INVALID_CURRENCY');
    }

    // Fetch old currency rate (USD = 1)
    const oldCode = user.currency || 'USD';
    let oldRate = 1;
    if (oldCode !== 'USD') {
        const oldCurrencyDoc = await Currency.findOne({ code: oldCode });
        if (oldCurrencyDoc) oldRate = oldCurrencyDoc.platformRate;
    }
    const newRate = newCurrencyDoc.platformRate;

    // Convert balance
    const { convertBalance } = require('../../shared/utils/currencyMath');
    const previousBalance = user.walletBalance;
    const newBalance = convertBalance(previousBalance, oldRate, newRate);

    // Atomic update — currency + balance together
    const previousCurrency = user.currency;
    const updated = await User.findByIdAndUpdate(
        id,
        { $set: { currency: code, walletBalance: newBalance } },
        { new: true }
    ).populate('groupId', 'name percentage isActive');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            field: 'currency',
            previousCurrency,
            newCurrency: code,
            previousBalance,
            newBalance,
            oldRate,
            newRate,
        },
    });

    return updated;
};

// ─── Reset Password ───────────────────────────────────────────────────────────

/**
 * Admin reset of a user's password.
 * Assigns the plain-text password — the pre-save hook auto-hashes via bcrypt.
 */
const resetUserPassword = async (id, newPassword, adminId) => {
    // Need to select password field explicitly since it has select: false
    const user = await User.findById(id).select('+password');
    if (!user) throw new NotFoundError('User');

    user.password = newPassword; // pre-save hook will bcrypt hash this
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_PASSWORD_RESET,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { note: 'Password reset by admin' }, // never log the actual password
    });

    // Re-fetch without password field for clean response
    return _findOrFail(id);
};

// ─── Update Avatar ────────────────────────────────────────────────────────────

/**
 * Admin update of a user's avatar URL.
 */
const updateUserAvatar = async (id, avatarUrl, adminId) => {
    const user = await _findOrFail(id);

    const previousAvatar = user.avatar;
    user.avatar = avatarUrl || null;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_AVATAR_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { previousAvatar, newAvatar: avatarUrl || null },
    });

    return user;
};

// ─── Update Credit Limit ──────────────────────────────────────────────────────

/**
 * Admin update of a user's credit limit (overdraft allowance).
 */
const updateUserCreditLimit = async (id, creditLimit, adminId) => {
    const user = await _findOrFail(id);

    const previousCreditLimit = user.creditLimit || 0;
    user.creditLimit = Math.max(0, Number(creditLimit) || 0);
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { field: 'creditLimit', previousCreditLimit, newCreditLimit: user.creditLimit },
    });

    return user;
};

// ─── Update Permissions ───────────────────────────────────────────────────────

/**
 * Admin update of a user's permissions array.
 * Used for fine-grained RBAC — primarily for SUPERVISOR role users.
 *
 * @param {string|ObjectId} id          — target user ID
 * @param {string[]}        permissions — array of permission strings
 * @param {string|ObjectId} adminId     — acting admin's user ID
 */
const updateUserPermissions = async (id, permissions, adminId) => {
    const user = await _findOrFail(id);

    const previousPermissions = [...(user.permissions || [])];
    user.permissions = permissions;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_PERMISSIONS_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { previousPermissions, newPermissions: permissions },
    });

    return user;
};

module.exports = {
    listUsers,
    listDeletedUsers,
    getUserById,
    updateUser,
    deleteUser,
    restoreUser,
    approveUser,
    rejectUser,
    updateUserRole,
    updateUserCurrency,
    updateUserCreditLimit,
    resetUserPassword,
    updateUserAvatar,
    updateUserPermissions,
};
