'use strict';

const mongoose = require('mongoose');
const { User, REFERRAL_SOURCE } = require('../users/user.model');
const {
    ReferralCommission,
    COMMISSION_STATUS,
} = require('./referralCommission.model');
const {
    getCommissionSummaryForReferrer,
    listCommissionsForReferrer,
    toMoneyString,
} = require('./referralCommission.service');

const DASHBOARD_SHARE_PATH = '/auth?mode=signup&ref=';

const normalizeObjectId = (value) => (
    value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(value)
);

const normalizePagination = ({ page = 1, limit = 20 } = {}) => {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    return { page: safePage, limit: safeLimit };
};

const normalizeLowerTotals = (summary) => ({
    available: summary?.totals?.[COMMISSION_STATUS.AVAILABLE] || '0.00',
    locked: summary?.totals?.[COMMISSION_STATUS.LOCKED] || '0.00',
    paid: summary?.totals?.[COMMISSION_STATUS.PAID] || '0.00',
    cancelled: summary?.totals?.[COMMISSION_STATUS.CANCELLED] || '0.00',
});

const maskEmail = (email) => {
    const value = String(email || '').trim();
    if (!value || !value.includes('@')) return null;

    const [local, domain] = value.split('@');
    if (!local || !domain) return null;
    const visible = local.slice(0, 1);
    return `${visible}***@${domain}`;
};

const serializeCommissionForReferrer = (commission) => ({
    id: String(commission._id || commission.id),
    status: commission.status,
    sourceAmountUsd: commission.sourceAmountUsd,
    commissionRatePercent: commission.commissionRatePercent,
    commissionAmountUsd: commission.commissionAmountUsd,
    commissionCurrency: commission.commissionCurrency,
    availableAt: commission.availableAt || null,
    lockedAt: commission.lockedAt || null,
    paidAt: commission.paidAt || null,
    cancelledAt: commission.cancelledAt || null,
    createdAt: commission.createdAt || null,
});

const serializeInviteeForReferrer = (user, commissionData = {}) => {
    const displayName = String(user.name || user.username || maskEmail(user.email) || 'Referral user').trim();

    return {
        id: String(user._id || user.id),
        displayName,
        maskedEmail: maskEmail(user.email),
        joinedAt: user.referredAt || user.createdAt || null,
        referralSource: user.referralSource || null,
        commissionSummary: {
            count: commissionData.count || 0,
            totalAvailableUsd: commissionData.totalAvailableUsd || '0.00',
        },
    };
};

const getDashboardForReferrer = async (referrerId) => {
    const objectId = normalizeObjectId(referrerId);

    const [referrer, inviteeTotal, commissionSummary] = await Promise.all([
        User.findById(objectId).select('referralCode').lean(),
        User.countDocuments({ referredBy: objectId, deletedAt: null }),
        getCommissionSummaryForReferrer(objectId),
    ]);

    const code = String(referrer?.referralCode || '').trim().toUpperCase();

    return {
        referral: {
            code,
            sharePath: code ? `${DASHBOARD_SHARE_PATH}${encodeURIComponent(code)}` : null,
        },
        referrals: {
            total: inviteeTotal,
        },
        commissions: {
            count: commissionSummary.count || 0,
            totals: normalizeLowerTotals(commissionSummary),
            currency: 'USD',
        },
    };
};

const listDashboardCommissionsForReferrer = async (referrerId, filters = {}) => {
    const result = await listCommissionsForReferrer(referrerId, filters);

    return {
        items: result.commissions.map(serializeCommissionForReferrer),
        pagination: result.pagination,
    };
};

const listInviteesForReferrer = async (referrerId, filters = {}) => {
    const objectId = normalizeObjectId(referrerId);
    const { page, limit } = normalizePagination(filters);
    const skip = (page - 1) * limit;

    const query = {
        referredBy: objectId,
        deletedAt: null,
    };

    if (filters.source) {
        query.referralSource = String(filters.source).trim().toUpperCase();
    }

    if (filters.dateFrom || filters.dateTo) {
        query.referredAt = {};
        if (filters.dateFrom) query.referredAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.referredAt.$lte = new Date(filters.dateTo);
    }

    const [invitees, total] = await Promise.all([
        User.find(query)
            .select('name username email avatar createdAt +referredAt +referralSource')
            .sort({ referredAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments(query),
    ]);

    const inviteeIds = invitees.map((invitee) => invitee._id);
    const rows = inviteeIds.length
        ? await ReferralCommission.aggregate([
            {
                $match: {
                    referrerId: objectId,
                    referredUserId: { $in: inviteeIds },
                },
            },
            {
                $group: {
                    _id: '$referredUserId',
                    count: { $sum: 1 },
                    totalAvailableUsd: {
                        $sum: {
                            $cond: [
                                { $eq: ['$status', COMMISSION_STATUS.AVAILABLE] },
                                { $toDecimal: '$commissionAmountUsd' },
                                { $toDecimal: '0.00' },
                            ],
                        },
                    },
                },
            },
        ])
        : [];

    const commissionByInvitee = new Map(
        rows.map((row) => [
            String(row._id),
            {
                count: row.count,
                totalAvailableUsd: toMoneyString(row.totalAvailableUsd.toString()),
            },
        ])
    );

    return {
        items: invitees.map((invitee) =>
            serializeInviteeForReferrer(invitee, commissionByInvitee.get(String(invitee._id)))
        ),
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

module.exports = {
    REFERRAL_SOURCE,
    getDashboardForReferrer,
    listDashboardCommissionsForReferrer,
    listInviteesForReferrer,
    serializeCommissionForReferrer,
    serializeInviteeForReferrer,
    maskEmail,
};
