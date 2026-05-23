'use strict';

/**
 * admin.stats.controller.js - Admin Dashboard Statistics
 */

const { Order, ORDER_STATUS } = require('../orders/order.model');
const { User, USER_STATUS } = require('../users/user.model');
const { Product } = require('../products/product.model');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');

const getDashboardStats = catchAsync(async (req, res) => {
    const parseDate = (value, { endOfDay = false } = {}) => {
        if (!value) return null;

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;

        if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
            date.setHours(23, 59, 59, 999);
        }

        return date;
    };

    const startDate = parseDate(req.query.startDate || req.query.from);
    const endDate = parseDate(req.query.endDate || req.query.to, { endOfDay: true });
    const orderMatch = {};

    if (startDate || endDate) {
        orderMatch.createdAt = {
            ...(startDate ? { $gte: startDate } : {}),
            ...(endDate ? { $lte: endDate } : {}),
        };
    }

    const toNumber = (field, fallback = 0) => ({
        $convert: {
            input: { $ifNull: [field, fallback] },
            to: 'double',
            onError: fallback,
            onNull: fallback,
        },
    });

    const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

    const [orderStatsResult, userStatsResult, productStatsResult] = await Promise.all([
        Order.aggregate([
            { $match: orderMatch },
            {
                $facet: {
                    totals: [
                        {
                            $group: {
                                _id: null,
                                totalOrders: { $sum: 1 },
                                completedOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.COMPLETED] }, 1, 0] },
                                },
                                pendingOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PENDING] }, 1, 0] },
                                },
                                processingOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PROCESSING] }, 1, 0] },
                                },
                                pendingProcessingOrders: {
                                    $sum: {
                                        $cond: [
                                            {
                                                $in: [
                                                    '$status',
                                                    [
                                                        ORDER_STATUS.PENDING,
                                                        ORDER_STATUS.PROCESSING,
                                                        ORDER_STATUS.MANUAL_REVIEW,
                                                    ],
                                                ],
                                            },
                                            1,
                                            0,
                                        ],
                                    },
                                },
                                failedOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.FAILED] }, 1, 0] },
                                },
                                canceledOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.CANCELED] }, 1, 0] },
                                },
                                partialOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PARTIAL] }, 1, 0] },
                                },
                                manualReviewOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.MANUAL_REVIEW] }, 1, 0] },
                                },
                            },
                        },
                    ],
                    financials: [
                        { $match: { status: ORDER_STATUS.COMPLETED } },
                        {
                            $project: {
                                revenue: toNumber('$totalPrice'),
                                revenueUsdSnapshot: toNumber('$usdAmount', null),
                                profitUsdSnapshot: toNumber('$profitUsd', null),
                                quantity: toNumber('$quantity', 1),
                                rateSnapshot: toNumber('$rateSnapshot', 1),
                                basePrice: toNumber('$basePriceSnapshot'),
                            },
                        },
                        {
                            $project: {
                                revenue: 1,
                                rateSnapshot: 1,
                                revenueUsd: {
                                    $ifNull: [
                                        '$revenueUsdSnapshot',
                                        {
                                            $cond: [
                                                { $gt: ['$rateSnapshot', 0] },
                                                { $divide: ['$revenue', '$rateSnapshot'] },
                                                '$revenue',
                                            ],
                                        },
                                    ],
                                },
                                profitUsdSnapshot: 1,
                                netProfit: {
                                    $subtract: [
                                        '$revenue',
                                        { $multiply: ['$basePrice', '$quantity', '$rateSnapshot'] },
                                    ],
                                },
                            },
                        },
                        {
                            $project: {
                                revenue: 1,
                                revenueUsd: 1,
                                netProfit: 1,
                                profitUsd: {
                                    $ifNull: [
                                        '$profitUsdSnapshot',
                                        {
                                            $cond: [
                                                { $gt: ['$rateSnapshot', 0] },
                                                { $divide: ['$netProfit', '$rateSnapshot'] },
                                                '$netProfit',
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: '$revenue' },
                                netProfit: { $sum: '$netProfit' },
                                totalRevenueUsd: { $sum: '$revenueUsd' },
                                totalProfitUsd: { $sum: '$profitUsd' },
                            },
                        },
                    ],
                },
            },
        ]),
        User.aggregate([
            { $match: { deletedAt: null } },
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    activeUsers: {
                        $sum: { $cond: [{ $eq: ['$status', USER_STATUS.ACTIVE] }, 1, 0] },
                    },
                    totalWalletBalance: { $sum: { $ifNull: ['$walletBalance', 0] } },
                },
            },
        ]),
        Product.aggregate([
            { $match: { deletedAt: null } },
            {
                $group: {
                    _id: null,
                    totalProducts: { $sum: 1 },
                    activeProducts: {
                        $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] },
                    },
                },
            },
        ]),
    ]);

    const orderStats = orderStatsResult?.[0] || {};
    const totals = orderStats?.totals?.[0] || {};
    const financials = orderStats?.financials?.[0] || {};
    const userStats = userStatsResult?.[0] || {};
    const productStats = productStatsResult?.[0] || {};

    sendSuccess(res, {
        orders: {
            total: totals.totalOrders || 0,
            completed: totals.completedOrders || 0,
            pending: totals.pendingOrders || 0,
            processing: totals.processingOrders || 0,
            pendingProcessing: totals.pendingProcessingOrders || 0,
            failed: totals.failedOrders || 0,
            canceled: totals.canceledOrders || 0,
            partial: totals.partialOrders || 0,
            manualReview: totals.manualReviewOrders || 0,
        },
        financials: {
            totalRevenue: roundMoney(financials.totalRevenue),
            netProfit: roundMoney(financials.netProfit),
            totalRevenueUsd: roundMoney(financials.totalRevenueUsd),
            totalProfitUsd: roundMoney(financials.totalProfitUsd),
        },
        users: {
            total: userStats.totalUsers || 0,
            active: userStats.activeUsers || 0,
            totalWalletBalance: roundMoney(userStats.totalWalletBalance),
        },
        products: {
            total: productStats.totalProducts || 0,
            active: productStats.activeProducts || 0,
        },
    }, 'Dashboard statistics retrieved.');
});

module.exports = { getDashboardStats };
