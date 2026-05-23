'use strict';

const walletService = require('./wallet.service');
const { WalletTransaction } = require('./walletTransaction.model');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

/**
 * Get the authenticated user's transaction history.
 */
const getMyTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

/**
 * Admin: Get any user's transaction history.
 */
const getUserTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.params.userId, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

/**
 * Get the authenticated user's wallet stats (aggregated from WalletTransaction).
 */
const getMyWalletStats = catchAsync(async (req, res) => {
    const userId = req.user._id;

    const [agg] = await WalletTransaction.aggregate([
        { $match: { userId, status: 'COMPLETED' } },
        {
            $group: {
                _id: null,
                totalDeposits: {
                    $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] },
                },
                totalSpent: {
                    $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] },
                },
                totalRefunds: {
                    $sum: { $cond: [{ $eq: ['$type', 'REFUND'] }, '$amount', 0] },
                },
                totalTransactions: { $sum: 1 },
            },
        },
    ]);

    const stats = {
        totalDeposits: agg?.totalDeposits || 0,
        totalSpent: agg?.totalSpent || 0,
        totalRefunds: agg?.totalRefunds || 0,
        netBalance: Number(req.user.walletBalance || 0),
        totalTransactions: agg?.totalTransactions || 0,
    };

    sendSuccess(res, stats, 'Wallet stats retrieved.');
});

module.exports = { getMyTransactions, getUserTransactions, getMyWalletStats };
