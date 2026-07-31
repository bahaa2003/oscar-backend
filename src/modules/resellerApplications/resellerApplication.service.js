'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { User, USER_STATUS, RESELLER_STATUS } = require('../users/user.model');
const Group = require('../groups/group.model');
const { getDefaultGroup } = require('../groups/group.service');
const {
    ResellerApplication,
    RESELLER_APPLICATION_STATUS,
    BUSINESS_TYPES,
    SALES_CHANNELS,
    CONTACT_METHODS,
} = require('./resellerApplication.model');
const { createAuditLog } = require('../audit/audit.service');
const {
    RESELLER_APPLICATION_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const notificationService = require('../notifications/notification.service');
const { BusinessRuleError, NotFoundError, ConflictError } = require('../../shared/errors/AppError');

const MAX_RESELLER_TRANSACTION_ATTEMPTS = 3;

const RESELLER_TRANSACTION_OPTIONS = Object.freeze({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
});

let resellerTestHooks = {};

const __setResellerApplicationTestHooks = (hooks = {}) => {
    resellerTestHooks = hooks || {};
};

const runTestHook = async (name, payload) => {
    if (process.env.NODE_ENV !== 'test') return;
    if (typeof resellerTestHooks[name] === 'function') {
        await resellerTestHooks[name](payload);
    }
};

const hasMongoErrorLabel = (err, label) => (
    typeof err?.hasErrorLabel === 'function'
        ? err.hasErrorLabel(label)
        : Array.isArray(err?.errorLabels) && err.errorLabels.includes(label)
);

const isMongoDuplicateKeyError = (err) => err?.code === 11000;

const makeRetryExhaustedError = () => new BusinessRuleError(
    'Reseller application transaction retry attempts were exhausted.',
    'RESELLER_TRANSACTION_RETRY_EXHAUSTED'
);

const withBoundedResellerTransactionRetry = async (session, transactionFn) => {
    for (let attempt = 1; attempt <= MAX_RESELLER_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
            return await session.withTransaction(transactionFn, RESELLER_TRANSACTION_OPTIONS);
        } catch (err) {
            if (!hasMongoErrorLabel(err, 'TransientTransactionError')) throw err;
            if (attempt === MAX_RESELLER_TRANSACTION_ATTEMPTS) throw makeRetryExhaustedError();
        }
    }
    throw makeRetryExhaustedError();
};

const startRequiredSession = async () => {
    let session;
    try {
        session = await mongoose.startSession();
    } catch (_) {
        throw new BusinessRuleError('Reseller workflow requires MongoDB transaction support.', 'RESELLER_TRANSACTION_UNAVAILABLE');
    }

    if (!session || typeof session.withTransaction !== 'function') {
        if (session) await session.endSession();
        throw new BusinessRuleError('Reseller workflow requires MongoDB transaction support.', 'RESELLER_TRANSACTION_UNAVAILABLE');
    }

    return session;
};

const normalizeObjectId = (value, resource = 'ObjectId') => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new BusinessRuleError(`${resource} is invalid.`, 'INVALID_OBJECT_ID');
    }
    return new mongoose.Types.ObjectId(value);
};

const normalizeString = (value, { required = false, min = 0, max = 500, field = 'value' } = {}) => {
    const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (required && text.length === 0) {
        throw new BusinessRuleError(`${field} is required.`, 'VALIDATION_ERROR');
    }
    if (text.length < min) {
        throw new BusinessRuleError(`${field} is too short.`, 'VALIDATION_ERROR');
    }
    if (text.length > max) {
        throw new BusinessRuleError(`${field} is too long.`, 'VALIDATION_ERROR');
    }
    return text || null;
};

const normalizeUrl = (value, field) => {
    const text = normalizeString(value, { max: 300, field });
    if (!text) return null;
    try {
        const parsed = new URL(text);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
        return parsed.toString();
    } catch (_) {
        throw new BusinessRuleError(`${field} must be a valid HTTP or HTTPS URL.`, 'VALIDATION_ERROR');
    }
};

const normalizeDecimalString = (value, field) => {
    const text = String(value ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(text)) {
        throw new BusinessRuleError(`${field} must be a non-negative number.`, 'VALIDATION_ERROR');
    }
    return text;
};

const normalizeArray = (value, { allowed = null, maxItems = 10, maxLength = 80, field }) => {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    if (list.length > maxItems) {
        throw new BusinessRuleError(`${field} has too many items.`, 'VALIDATION_ERROR');
    }
    const normalized = list
        .map((item) => normalizeString(item, { max: maxLength, field }))
        .filter(Boolean)
        .map((item) => allowed ? item.toUpperCase() : item);
    if (allowed) {
        for (const item of normalized) {
            if (!allowed.includes(item)) {
                throw new BusinessRuleError(`${field} contains an unsupported value.`, 'VALIDATION_ERROR');
            }
        }
    }
    return [...new Set(normalized)];
};

const normalizeApplicationPayload = (payload = {}, user = null) => {
    const businessName = normalizeString(
        payload.businessName || user?.name,
        { required: true, min: 2, max: 120, field: 'businessName' }
    );
    const businessType = normalizeString(payload.businessType || BUSINESS_TYPES.INDIVIDUAL, { max: 40, field: 'businessType' }).toUpperCase();
    if (!Object.values(BUSINESS_TYPES).includes(businessType)) {
        throw new BusinessRuleError('businessType is unsupported.', 'VALIDATION_ERROR');
    }

    const preferredContactMethod = normalizeString(
        payload.preferredContactMethod || CONTACT_METHODS.WHATSAPP,
        { max: 40, field: 'preferredContactMethod' }
    ).toUpperCase();
    if (!Object.values(CONTACT_METHODS).includes(preferredContactMethod)) {
        throw new BusinessRuleError('preferredContactMethod is unsupported.', 'VALIDATION_ERROR');
    }

    return {
        businessName,
        businessType,
        country: normalizeString(payload.country || 'Egypt', { required: true, min: 2, max: 80, field: 'country' }),
        city: normalizeString(payload.city || 'Cairo', { required: true, min: 2, max: 80, field: 'city' }),
        expectedMonthlyVolume: normalizeDecimalString(payload.expectedMonthlyVolume ?? '0', 'expectedMonthlyVolume'),
        experienceSummary: normalizeString(payload.experienceSummary || payload.message, {
            required: true,
            min: 10,
            max: 2000,
            field: 'experienceSummary',
        }),
        salesChannels: normalizeArray(payload.salesChannels || [SALES_CHANNELS.OTHER], {
            allowed: Object.values(SALES_CHANNELS),
            maxItems: 6,
            field: 'salesChannels',
        }),
        targetMarkets: normalizeArray(payload.targetMarkets || ['Local'], {
            maxItems: 10,
            maxLength: 80,
            field: 'targetMarkets',
        }),
        websiteUrl: normalizeUrl(payload.websiteUrl, 'websiteUrl'),
        socialProfileUrl: normalizeUrl(payload.socialProfileUrl, 'socialProfileUrl'),
        contactPhone: normalizeString(payload.contactPhone || payload.phone || user?.phone || 'not-provided', {
            required: true,
            min: 6,
            max: 40,
            field: 'contactPhone',
        }),
        preferredContactMethod,
    };
};

const makeApplicationNumber = () => {
    const year = new Date().getUTCFullYear();
    return `RSA-${year}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const makeIdempotencyKey = (userId, normalizedPayload) => {
    const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(normalizedPayload))
        .digest('hex')
        .slice(0, 32);
    return `reseller:${userId}:${hash}:${crypto.randomBytes(8).toString('hex')}:v1`;
};

const maskEmail = (email) => {
    const text = String(email || '');
    const [local, domain] = text.split('@');
    if (!local || !domain) return null;
    return `${local.slice(0, 1)}***@${domain}`;
};

const serializeGroup = (group) => {
    if (!group) return null;
    return {
        id: String(group._id || group.id),
        name: group.name || null,
        isActive: group.isActive !== false,
        isDefault: Boolean(group.isDefault),
    };
};

const serializeApplicationForUser = (application) => {
    if (!application) return null;
    const app = typeof application.toObject === 'function' ? application.toObject() : application;
    return {
        id: String(app._id || app.id),
        applicationNumber: app.applicationNumber,
        status: app.status,
        businessName: app.businessName,
        businessType: app.businessType,
        country: app.country,
        city: app.city,
        expectedMonthlyVolume: app.expectedMonthlyVolume,
        experienceSummary: app.experienceSummary,
        salesChannels: app.salesChannels || [],
        targetMarkets: app.targetMarkets || [],
        submittedAt: app.submittedAt || null,
        reviewedAt: app.reviewedAt || null,
        approvedAt: app.approvedAt || null,
        rejectedAt: app.rejectedAt || null,
        rejectionReason: app.rejectionReason || null,
        suspendedAt: app.suspendedAt || null,
        suspensionReason: app.suspensionReason || null,
        reactivatedAt: app.reactivatedAt || null,
        assignedGroup: serializeGroup(app.assignedGroupId),
    };
};

const serializeApplicationForAdmin = (application) => {
    if (!application) return null;
    const app = typeof application.toObject === 'function' ? application.toObject() : application;
    const user = app.userId && typeof app.userId === 'object' ? app.userId : null;
    return {
        ...serializeApplicationForUser(app),
        user: user ? {
            id: String(user._id || user.id),
            name: user.name || null,
            emailMasked: maskEmail(user.email),
            resellerStatus: user.resellerStatus || null,
            status: user.status || null,
        } : null,
        contactPhoneMasked: app.contactPhone ? `***${String(app.contactPhone).slice(-4)}` : null,
        websiteUrl: app.websiteUrl || null,
        socialProfileUrl: app.socialProfileUrl || null,
        requestedGroup: serializeGroup(app.requestedGroupId),
        previousGroup: serializeGroup(app.previousGroupId),
    };
};

const getLatestApplicationForUser = async (userId, session = null) => {
    const query = ResellerApplication.findOne({ userId }).sort({ submittedAt: -1, createdAt: -1 })
        .populate('assignedGroupId', 'name isActive isDefault')
        .populate('previousGroupId', 'name isActive isDefault');
    if (session) query.session(session);
    return query;
};

const assertActiveAssignableGroup = async (groupId, session = null) => {
    const id = normalizeObjectId(groupId, 'assignedGroupId');
    const query = Group.findById(id);
    if (session) query.session(session);
    const group = await query;
    if (!group) throw new NotFoundError('Group');
    if (group.deletedAt) throw new BusinessRuleError('Selected group is deleted.', 'GROUP_DELETED');
    if (!group.isActive) throw new BusinessRuleError('Selected group is inactive.', 'GROUP_INACTIVE');
    return group;
};

const buildAuditContext = (auditContext, fallbackActorId, fallbackRole) => ({
    actorId: auditContext?.actorId ?? fallbackActorId,
    actorRole: auditContext?.actorRole ?? fallbackRole,
    ipAddress: auditContext?.ipAddress ?? null,
    userAgent: auditContext?.userAgent ?? null,
});

const auditAndNotify = ({ action, application, actorId, actorRole, auditContext, metadata = {} }) => {
    const ctx = buildAuditContext(auditContext, actorId, actorRole);
    createAuditLog({
        ...ctx,
        action,
        entityType: ENTITY_TYPES.RESELLER_APPLICATION,
        entityId: application._id,
        metadata: {
            applicationId: String(application._id),
            applicationNumber: application.applicationNumber,
            userId: String(application.userId?._id || application.userId),
            status: application.status,
            ...metadata,
        },
    });

    if (action === RESELLER_APPLICATION_ACTIONS.SUBMITTED) {
        notificationService.notifyResellerApplicationSubmitted(application);
    } else if (action === RESELLER_APPLICATION_ACTIONS.APPROVED) {
        notificationService.notifyResellerApplicationApproved(application);
    } else if (action === RESELLER_APPLICATION_ACTIONS.REJECTED) {
        notificationService.notifyResellerApplicationRejected(application);
    } else if (action === RESELLER_APPLICATION_ACTIONS.SUSPENDED) {
        notificationService.notifyResellerSuspended(application);
    } else if (action === RESELLER_APPLICATION_ACTIONS.REACTIVATED) {
        notificationService.notifyResellerReactivated(application);
    }
};

const submitApplication = async (userId, payload = {}, auditContext = null) => {
    const normalizedUserId = normalizeObjectId(userId, 'userId');
    const user = await User.findById(normalizedUserId).select('+referredBy');
    if (!user) throw new NotFoundError('User');
    if (user.status !== USER_STATUS.ACTIVE || user.deletedAt) {
        throw new BusinessRuleError('Only active users can apply as resellers.', 'ACCOUNT_INACTIVE');
    }

    const normalizedPayload = normalizeApplicationPayload(payload, user);

    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;
    let attempts = 0;

    try {
        result = await withBoundedResellerTransactionRetry(session, async () => {
            attempts += 1;
            await runTestHook('transactionAttemptStarted', { operation: 'submit', attempt: attempts });

            const applicant = await User.findById(normalizedUserId).session(session);
            if (!applicant) throw new NotFoundError('User');
            if (applicant.status !== USER_STATUS.ACTIVE || applicant.deletedAt) {
                throw new BusinessRuleError('Only active users can apply as resellers.', 'ACCOUNT_INACTIVE');
            }
            if ([RESELLER_STATUS.APPROVED, RESELLER_STATUS.SUSPENDED].includes(applicant.resellerStatus)) {
                throw new BusinessRuleError('This account already has a reseller commercial state.', 'RESELLER_ALREADY_COMMERCIAL');
            }

            const existingPending = await ResellerApplication
                .findOne({ userId: normalizedUserId, status: RESELLER_APPLICATION_STATUS.PENDING })
                .session(session);
            if (existingPending) {
                const existingSummary = normalizeApplicationPayload(existingPending.toObject(), applicant);
                if (JSON.stringify(existingSummary) === JSON.stringify(normalizedPayload)) {
                    isIdempotent = true;
                    return existingPending;
                }
                throw new ConflictError('A pending reseller application already exists.');
            }

            if (applicant.resellerStatus === RESELLER_STATUS.REJECTED) {
                const cooldownDays = Math.max(0, Number(config.reseller?.reapplicationCooldownDays || 0));
                if (cooldownDays > 0 && applicant.resellerRejectedAt) {
                    const retryAt = new Date(applicant.resellerRejectedAt.getTime() + cooldownDays * 24 * 60 * 60 * 1000);
                    if (retryAt > new Date()) {
                        throw new BusinessRuleError('Reseller reapplication cooldown is still active.', 'RESELLER_REAPPLICATION_COOLDOWN_ACTIVE');
                    }
                }
            }

            const now = new Date();
            const [application] = await ResellerApplication.create([{
                userId: normalizedUserId,
                applicationNumber: makeApplicationNumber(),
                ...normalizedPayload,
                applicationSnapshot: {
                    submittedByUserId: String(normalizedUserId),
                    resellerStatusBefore: applicant.resellerStatus,
                    groupIdBefore: applicant.groupId ? String(applicant.groupId) : null,
                },
                idempotencyKey: makeIdempotencyKey(normalizedUserId, normalizedPayload),
                submittedAt: now,
            }], { session });

            applicant.resellerStatus = RESELLER_STATUS.PENDING;
            applicant.resellerRejectedAt = null;
            applicant.resellerRejectionReason = null;
            await applicant.save({ session });

            await runTestHook('afterApplicationCreated', { application, attempt: attempts });
            return application;
        });
    } catch (err) {
        if (isMongoDuplicateKeyError(err)) {
            throw new ConflictError('A pending reseller application already exists.');
        }
        throw err;
    } finally {
        await session.endSession();
    }

    if (!isIdempotent) {
        auditAndNotify({
            action: RESELLER_APPLICATION_ACTIONS.SUBMITTED,
            application: result,
            actorId: normalizedUserId,
            actorRole: ACTOR_ROLES.CUSTOMER,
            auditContext,
            metadata: { oldStatus: RESELLER_STATUS.NONE, newStatus: RESELLER_STATUS.PENDING },
        });
    }

    return result;
};

const getCurrentForUser = async (userId) => {
    const normalizedUserId = normalizeObjectId(userId, 'userId');
    const [user, application] = await Promise.all([
        User.findById(normalizedUserId).populate('resellerGroupId', 'name isActive isDefault').lean(),
        getLatestApplicationForUser(normalizedUserId),
    ]);
    if (!user) throw new NotFoundError('User');
    return {
        resellerStatus: user.resellerStatus || RESELLER_STATUS.NONE,
        application: serializeApplicationForUser(application),
        commercial: {
            approved: user.resellerStatus === RESELLER_STATUS.APPROVED,
            assignedGroup: serializeGroup(user.resellerGroupId),
        },
        canApply: [RESELLER_STATUS.NONE, RESELLER_STATUS.REJECTED].includes(user.resellerStatus || RESELLER_STATUS.NONE),
    };
};

const listHistoryForUser = async (userId, { page = 1, limit = 20 } = {}) => {
    const normalizedUserId = normalizeObjectId(userId, 'userId');
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
        ResellerApplication.find({ userId: normalizedUserId })
            .sort({ submittedAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .populate('assignedGroupId', 'name isActive isDefault'),
        ResellerApplication.countDocuments({ userId: normalizedUserId }),
    ]);
    return {
        items: items.map(serializeApplicationForUser),
        pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
    };
};

const buildAdminFilter = (filters = {}) => {
    const filter = {};
    if (filters.status) filter.status = String(filters.status).toUpperCase();
    if (filters.country) filter.country = normalizeString(filters.country, { max: 80, field: 'country' });
    if (filters.businessType) filter.businessType = String(filters.businessType).toUpperCase();
    if (filters.dateFrom || filters.dateTo) {
        filter.submittedAt = {};
        if (filters.dateFrom) filter.submittedAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) filter.submittedAt.$lte = new Date(filters.dateTo);
    }
    if (filters.search) {
        const search = normalizeString(filters.search, { max: 80, field: 'search' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
            { applicationNumber: { $regex: search, $options: 'i' } },
            { businessName: { $regex: search, $options: 'i' } },
        ];
    }
    return filter;
};

const listApplicationsForAdmin = async (filters = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = buildAdminFilter(filters);
    const [items, total] = await Promise.all([
        ResellerApplication.find(filter)
            .sort({ submittedAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email status resellerStatus')
            .populate('assignedGroupId', 'name isActive isDefault')
            .populate('requestedGroupId', 'name isActive isDefault')
            .populate('previousGroupId', 'name isActive isDefault'),
        ResellerApplication.countDocuments(filter),
    ]);
    return {
        items: items.map(serializeApplicationForAdmin),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

const getApplicationForAdmin = async (id) => {
    const application = await ResellerApplication.findById(normalizeObjectId(id, 'applicationId'))
        .populate('userId', 'name email status resellerStatus groupId')
        .populate('assignedGroupId', 'name isActive isDefault')
        .populate('requestedGroupId', 'name isActive isDefault')
        .populate('previousGroupId', 'name isActive isDefault');
    if (!application) throw new NotFoundError('ResellerApplication');
    return serializeApplicationForAdmin(application);
};

const approveApplication = async (applicationId, adminId, { assignedGroupId } = {}, auditContext = null) => {
    const normalizedApplicationId = normalizeObjectId(applicationId, 'applicationId');
    const normalizedAdminId = normalizeObjectId(adminId, 'adminId');
    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;

    try {
        result = await withBoundedResellerTransactionRetry(session, async () => {
            const existing = await ResellerApplication.findById(normalizedApplicationId).session(session);
            if (!existing) throw new NotFoundError('ResellerApplication');
            if (existing.status === RESELLER_APPLICATION_STATUS.APPROVED) {
                const user = await User.findById(existing.userId).session(session);
                if (
                    user?.resellerStatus === RESELLER_STATUS.APPROVED
                    && existing.assignedGroupId
                    && String(user.groupId) === String(existing.assignedGroupId)
                ) {
                    isIdempotent = true;
                    return existing;
                }
                throw new BusinessRuleError('Approved reseller application requires reconciliation.', 'RESELLER_RECONCILIATION_REQUIRED');
            }
            if (existing.status !== RESELLER_APPLICATION_STATUS.PENDING) {
                throw new BusinessRuleError('Only pending reseller applications can be approved.', 'INVALID_RESELLER_TRANSITION');
            }

            const group = await assertActiveAssignableGroup(assignedGroupId, session);
            const applicant = await User.findById(existing.userId).session(session);
            if (!applicant) throw new NotFoundError('User');
            if (applicant.status !== USER_STATUS.ACTIVE || applicant.deletedAt) {
                throw new BusinessRuleError('Cannot approve reseller application for inactive or deleted user.', 'APPLICANT_INACTIVE');
            }

            const now = new Date();
            const previousGroupId = applicant.groupId || null;
            existing.status = RESELLER_APPLICATION_STATUS.APPROVED;
            existing.reviewedBy = normalizedAdminId;
            existing.reviewedAt = now;
            existing.approvedAt = now;
            existing.assignedGroupId = group._id;
            existing.previousGroupId = previousGroupId;
            existing.applicationSnapshot = {
                ...(existing.applicationSnapshot || {}),
                previousGroupId: previousGroupId ? String(previousGroupId) : null,
                assignedGroupId: String(group._id),
                approvedBy: String(normalizedAdminId),
            };
            await existing.save({ session });

            applicant.resellerStatus = RESELLER_STATUS.APPROVED;
            applicant.resellerApprovedAt = now;
            applicant.resellerApprovedBy = normalizedAdminId;
            applicant.resellerRejectedAt = null;
            applicant.resellerRejectionReason = null;
            applicant.resellerSuspendedAt = null;
            applicant.resellerSuspensionReason = null;
            applicant.resellerReactivatedAt = null;
            applicant.resellerGroupId = group._id;
            applicant.groupId = group._id;
            await applicant.save({ session });

            await runTestHook('afterApplicationApproved', { application: existing });
            return existing;
        });
    } finally {
        await session.endSession();
    }

    if (!isIdempotent) {
        auditAndNotify({
            action: RESELLER_APPLICATION_ACTIONS.APPROVED,
            application: result,
            actorId: normalizedAdminId,
            actorRole: ACTOR_ROLES.ADMIN,
            auditContext,
            metadata: {
                oldStatus: RESELLER_APPLICATION_STATUS.PENDING,
                newStatus: RESELLER_APPLICATION_STATUS.APPROVED,
                assignedGroupId: String(result.assignedGroupId),
            },
        });
    }

    return result;
};

const rejectApplication = async (applicationId, adminId, { rejectionReason } = {}, auditContext = null) => {
    const normalizedApplicationId = normalizeObjectId(applicationId, 'applicationId');
    const normalizedAdminId = normalizeObjectId(adminId, 'adminId');
    const reason = normalizeString(rejectionReason, { required: true, min: 3, max: 500, field: 'rejectionReason' });
    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;

    try {
        result = await withBoundedResellerTransactionRetry(session, async () => {
            const application = await ResellerApplication.findById(normalizedApplicationId).session(session);
            if (!application) throw new NotFoundError('ResellerApplication');
            if (application.status === RESELLER_APPLICATION_STATUS.REJECTED) {
                isIdempotent = true;
                return application;
            }
            if (application.status !== RESELLER_APPLICATION_STATUS.PENDING) {
                throw new BusinessRuleError('Only pending reseller applications can be rejected.', 'INVALID_RESELLER_TRANSITION');
            }

            const user = await User.findById(application.userId).session(session);
            if (!user) throw new NotFoundError('User');
            const now = new Date();
            application.status = RESELLER_APPLICATION_STATUS.REJECTED;
            application.reviewedBy = normalizedAdminId;
            application.reviewedAt = now;
            application.rejectedAt = now;
            application.rejectionReason = reason;
            await application.save({ session });

            user.resellerStatus = RESELLER_STATUS.REJECTED;
            user.resellerRejectedAt = now;
            user.resellerRejectionReason = reason;
            await user.save({ session });
            await runTestHook('afterApplicationRejected', { application });
            return application;
        });
    } finally {
        await session.endSession();
    }

    if (!isIdempotent) {
        auditAndNotify({
            action: RESELLER_APPLICATION_ACTIONS.REJECTED,
            application: result,
            actorId: normalizedAdminId,
            actorRole: ACTOR_ROLES.ADMIN,
            auditContext,
            metadata: { oldStatus: RESELLER_APPLICATION_STATUS.PENDING, newStatus: RESELLER_APPLICATION_STATUS.REJECTED },
        });
    }

    return result;
};

const findLatestCommercialApplication = async (userId, session) => {
    const application = await ResellerApplication.findOne({
        userId,
        status: { $in: [RESELLER_APPLICATION_STATUS.APPROVED, RESELLER_APPLICATION_STATUS.SUSPENDED] },
    }).sort({ approvedAt: -1, updatedAt: -1 }).session(session);
    if (!application) {
        throw new BusinessRuleError('Approved reseller application is missing.', 'RESELLER_RECONCILIATION_REQUIRED');
    }
    return application;
};

const suspendApplication = async (applicationId, adminId, { suspensionReason } = {}, auditContext = null) => {
    const normalizedApplicationId = normalizeObjectId(applicationId, 'applicationId');
    const normalizedAdminId = normalizeObjectId(adminId, 'adminId');
    const reason = normalizeString(suspensionReason || 'Commercial reseller access suspended.', {
        required: true,
        min: 3,
        max: 500,
        field: 'suspensionReason',
    });
    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;

    try {
        result = await withBoundedResellerTransactionRetry(session, async () => {
            const application = await ResellerApplication.findById(normalizedApplicationId).session(session);
            if (!application) throw new NotFoundError('ResellerApplication');
            if (application.status === RESELLER_APPLICATION_STATUS.SUSPENDED) {
                isIdempotent = true;
                return application;
            }
            if (application.status !== RESELLER_APPLICATION_STATUS.APPROVED) {
                throw new BusinessRuleError('Only approved reseller applications can be suspended.', 'INVALID_RESELLER_TRANSITION');
            }

            const user = await User.findOne({ _id: application.userId, resellerStatus: RESELLER_STATUS.APPROVED }).session(session);
            if (!user) throw new BusinessRuleError('Approved reseller user was not found.', 'RESELLER_RECONCILIATION_REQUIRED');
            const defaultGroup = await getDefaultGroup();
            const sessionDefaultGroup = await Group.findById(defaultGroup._id).session(session);
            if (!sessionDefaultGroup || sessionDefaultGroup.deletedAt || !sessionDefaultGroup.isActive || !sessionDefaultGroup.isDefault) {
                throw new BusinessRuleError('Default group is not available for suspension.', 'DEFAULT_GROUP_NOT_CONFIGURED');
            }

            const now = new Date();
            application.status = RESELLER_APPLICATION_STATUS.SUSPENDED;
            application.reviewedBy = normalizedAdminId;
            application.reviewedAt = now;
            application.suspendedAt = now;
            application.suspensionReason = reason;
            await application.save({ session });

            user.resellerStatus = RESELLER_STATUS.SUSPENDED;
            user.resellerSuspendedAt = now;
            user.resellerSuspensionReason = reason;
            user.groupId = sessionDefaultGroup._id;
            await user.save({ session });
            await runTestHook('afterResellerSuspended', { application });
            return application;
        });
    } finally {
        await session.endSession();
    }

    if (!isIdempotent) {
        auditAndNotify({
            action: RESELLER_APPLICATION_ACTIONS.SUSPENDED,
            application: result,
            actorId: normalizedAdminId,
            actorRole: ACTOR_ROLES.ADMIN,
            auditContext,
            metadata: { oldStatus: RESELLER_APPLICATION_STATUS.APPROVED, newStatus: RESELLER_APPLICATION_STATUS.SUSPENDED },
        });
    }

    return result;
};

const reactivateApplication = async (applicationId, adminId, { assignedGroupId } = {}, auditContext = null) => {
    const normalizedApplicationId = normalizeObjectId(applicationId, 'applicationId');
    const normalizedAdminId = normalizeObjectId(adminId, 'adminId');
    let session = await startRequiredSession();
    let result;
    let isIdempotent = false;

    try {
        result = await withBoundedResellerTransactionRetry(session, async () => {
            const application = await ResellerApplication.findById(normalizedApplicationId).session(session);
            if (!application) throw new NotFoundError('ResellerApplication');
            if (application.status === RESELLER_APPLICATION_STATUS.APPROVED) {
                const user = await User.findById(application.userId).session(session);
                if (user?.resellerStatus === RESELLER_STATUS.APPROVED) {
                    isIdempotent = true;
                    return application;
                }
            }
            if (application.status !== RESELLER_APPLICATION_STATUS.SUSPENDED) {
                throw new BusinessRuleError('Only suspended reseller applications can be reactivated.', 'INVALID_RESELLER_TRANSITION');
            }

            const user = await User.findOne({ _id: application.userId, resellerStatus: RESELLER_STATUS.SUSPENDED }).session(session);
            if (!user) throw new BusinessRuleError('Suspended reseller user was not found.', 'RESELLER_RECONCILIATION_REQUIRED');

            let groupId = assignedGroupId || application.assignedGroupId;
            const group = await assertActiveAssignableGroup(groupId, session);
            const now = new Date();
            application.status = RESELLER_APPLICATION_STATUS.APPROVED;
            application.reviewedBy = normalizedAdminId;
            application.reviewedAt = now;
            application.reactivatedAt = now;
            application.assignedGroupId = group._id;
            await application.save({ session });

            user.resellerStatus = RESELLER_STATUS.APPROVED;
            user.resellerReactivatedAt = now;
            user.resellerSuspendedAt = null;
            user.resellerSuspensionReason = null;
            user.resellerGroupId = group._id;
            user.groupId = group._id;
            await user.save({ session });
            await runTestHook('afterResellerReactivated', { application });
            return application;
        });
    } finally {
        await session.endSession();
    }

    if (!isIdempotent) {
        auditAndNotify({
            action: RESELLER_APPLICATION_ACTIONS.REACTIVATED,
            application: result,
            actorId: normalizedAdminId,
            actorRole: ACTOR_ROLES.ADMIN,
            auditContext,
            metadata: { oldStatus: RESELLER_APPLICATION_STATUS.SUSPENDED, newStatus: RESELLER_APPLICATION_STATUS.APPROVED },
        });
    }

    return result;
};

module.exports = {
    MAX_RESELLER_TRANSACTION_ATTEMPTS,
    submitApplication,
    getCurrentForUser,
    listHistoryForUser,
    listApplicationsForAdmin,
    getApplicationForAdmin,
    approveApplication,
    rejectApplication,
    suspendApplication,
    reactivateApplication,
    serializeApplicationForUser,
    serializeApplicationForAdmin,
    __setResellerApplicationTestHooks,
    RESELLER_APPLICATION_STATUS,
};
