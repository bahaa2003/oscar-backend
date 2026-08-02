'use strict';

const mongoose = require('mongoose');
const config = require('../../config/config');
const { User } = require('../users/user.model');
const {
    ReferralCommission,
} = require('./referralCommission.model');
const {
    ReferralPayoutRequest,
    PAYOUT_STATUS,
} = require('./referralPayoutRequest.model');

const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const toMoney = (value) => toNumber(value).toFixed(2);

const serializeUser = (user) => ({
    id: String(user._id || user.id),
    name: user.name || user.username || user.email || '',
    username: user.username || '',
    email: user.email || '',
    phone: user.phone || '',
    avatar: user.avatar || null,
    referralCode: user.referralCode || '',
    currency: String(user.currency || 'USD').toUpperCase(),
    createdAt: user.createdAt || null,
    referredAt: user.referredAt || null,
    referralSource: user.referralSource || null,
});

const getAdminReferralDashboard = async () => {
    const [
        referredUsers,
        commissionRows,
        payoutRows,
    ] = await Promise.all([
        User.find({ referredBy: { $ne: null }, deletedAt: null })
            .select('name username email phone avatar currency createdAt referralCode +referredBy +referredAt +referralSource')
            .sort({ referredAt: -1, createdAt: -1, _id: 1 })
            .lean(),
        ReferralCommission.aggregate([
            {
                $group: {
                    _id: {
                        referrerId: '$referrerId',
                        referredUserId: '$referredUserId',
                    },
                    commissionCount: { $sum: 1 },
                    sourceAmountUsd: { $sum: { $toDecimal: '$sourceAmountUsd' } },
                    commissionAmountUsd: { $sum: { $toDecimal: '$commissionAmountUsd' } },
                },
            },
        ]),
        ReferralPayoutRequest.aggregate([
            { $match: { status: PAYOUT_STATUS.PAID } },
            {
                $group: {
                    _id: '$referrerId',
                    withdrawnUsd: { $sum: { $toDecimal: '$amountUsd' } },
                    payoutCount: { $sum: 1 },
                },
            },
        ]),
    ]);

    const referrerIds = new Set();
    referredUsers.forEach((user) => {
        if (user.referredBy) referrerIds.add(String(user.referredBy));
    });
    commissionRows.forEach((row) => {
        if (row._id?.referrerId) referrerIds.add(String(row._id.referrerId));
    });
    payoutRows.forEach((row) => {
        if (row._id) referrerIds.add(String(row._id));
    });

    const owners = referrerIds.size
        ? await User.find({
            _id: { $in: [...referrerIds].map((id) => new mongoose.Types.ObjectId(id)) },
            deletedAt: null,
        })
            .select('name username email phone avatar currency createdAt referralCode')
            .sort({ createdAt: -1, _id: 1 })
            .lean()
        : [];

    const commissionByPair = new Map();
    const ownerTotals = new Map();
    commissionRows.forEach((row) => {
        const referrerId = String(row._id.referrerId);
        const referredUserId = String(row._id.referredUserId);
        const pairKey = `${referrerId}:${referredUserId}`;
        const sourceAmountUsd = toNumber(row.sourceAmountUsd?.toString?.() ?? row.sourceAmountUsd);
        const commissionAmountUsd = toNumber(row.commissionAmountUsd?.toString?.() ?? row.commissionAmountUsd);

        commissionByPair.set(pairKey, {
            commissionCount: row.commissionCount || 0,
            sourceAmountUsd,
            commissionAmountUsd,
        });

        const current = ownerTotals.get(referrerId) || {
            depositsUsd: 0,
            earningsUsd: 0,
        };
        current.depositsUsd += sourceAmountUsd;
        current.earningsUsd += commissionAmountUsd;
        ownerTotals.set(referrerId, current);
    });

    const payoutByOwner = new Map();
    payoutRows.forEach((row) => {
        payoutByOwner.set(String(row._id), {
            withdrawnUsd: toNumber(row.withdrawnUsd?.toString?.() ?? row.withdrawnUsd),
            payoutCount: row.payoutCount || 0,
        });
    });

    const inviteesByOwner = new Map();
    referredUsers.forEach((invitee) => {
        const ownerId = String(invitee.referredBy);
        const pairSummary = commissionByPair.get(`${ownerId}:${String(invitee._id)}`) || {};
        const list = inviteesByOwner.get(ownerId) || [];
        list.push({
            ...serializeUser(invitee),
            addedAmount: toMoney(pairSummary.sourceAmountUsd || 0),
            earnings: toMoney(pairSummary.commissionAmountUsd || 0),
            commissionCount: pairSummary.commissionCount || 0,
            invitedAt: invitee.referredAt || invitee.createdAt || null,
        });
        inviteesByOwner.set(ownerId, list);
    });

    const serializedOwners = owners.map((owner) => {
        const ownerId = String(owner._id);
        const totals = ownerTotals.get(ownerId) || {};
        const payouts = payoutByOwner.get(ownerId) || {};

        return {
            ...serializeUser(owner),
            code: owner.referralCode || '',
            currency: 'USD',
            referrals: inviteesByOwner.get(ownerId) || [],
            earnings: toMoney(totals.earningsUsd || 0),
            deposits: toMoney(totals.depositsUsd || 0),
            withdrawn: toMoney(payouts.withdrawnUsd || 0),
            withdrawals: [],
        };
    });

    const totals = serializedOwners.reduce((acc, owner) => {
        acc.owners += 1;
        acc.invited += owner.referrals.length;
        acc.deposits += toNumber(owner.deposits);
        acc.earnings += toNumber(owner.earnings);
        acc.withdrawn += toNumber(owner.withdrawn);
        return acc;
    }, {
        owners: 0,
        invited: 0,
        deposits: 0,
        earnings: 0,
        withdrawn: 0,
    });

    return {
        summary: {
            ...totals,
            currency: serializedOwners.length ? 'USD' : 'EGP',
            commissionRatePercent: config.referralCommission?.enabled
                ? Number(config.referralCommission.ratePercent || 0)
                : 0,
        },
        owners: serializedOwners,
    };
};

module.exports = {
    getAdminReferralDashboard,
};
