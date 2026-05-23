'use strict';

/**
 * admin.wallet.controller.js
 */

const svc = require('./admin.wallet.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');

// GET /admin/wallets
const listWallets = catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await svc.listWallets({
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
    });
    sendPaginated(res, result.wallets, result.pagination, 'Wallets retrieved');
});

// GET /admin/wallets/:userId
const getWallet = catchAsync(async (req, res) => {
    const wallet = await svc.getWallet(req.params.userId);
    sendSuccess(res, { wallet }, 'Wallet retrieved');
});

// GET /admin/wallets/:userId/transactions
const getTransactionHistory = catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await svc.getTransactionHistory(req.params.userId, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
    });
    sendPaginated(res, result.transactions, result.pagination, 'Transactions retrieved');
});

// POST /admin/wallets/:userId/add
const addFunds = catchAsync(async (req, res) => {
    const { amount, reason, description } = req.body;
    const result = await svc.addFunds(req.params.userId, amount, reason || description, req.user._id);
    sendCreated(res, { transaction: result.transaction }, 'Funds added to wallet');
});

// POST /admin/wallets/:userId/deduct
const deductFunds = catchAsync(async (req, res) => {
    const { amount, reason, description } = req.body;
    const result = await svc.deductFunds(req.params.userId, amount, reason || description, req.user._id);
    sendSuccess(res, { transaction: result.transaction }, 'Funds deducted from wallet');
});

// PUT /admin/wallets/:userId/set
const setBalance = catchAsync(async (req, res) => {
    const { targetBalance, reason, description } = req.body;
    const result = await svc.setBalance(req.params.userId, targetBalance, reason || description, req.user._id);
    sendSuccess(res, { transaction: result.transaction, user: result.user }, 'Balance set successfully');
});

// POST /admin/users/adjust-debt
const adjustDebt = catchAsync(async (req, res) => {
    const { percentage } = req.body;
    const result = await svc.adjustNegativeBalancesForInflation(percentage, req.user._id);
    sendSuccess(res, {
        usersAdjusted: result.usersAdjusted,
        totalAdjustment: result.totalAdjustment,
        totalUsersInDebt: result.totalUsersInDebt,
        errors: result.errors.length > 0 ? result.errors : undefined,
    }, `Debt adjustment (${percentage}%) applied to ${result.usersAdjusted} users`);
});

module.exports = { listWallets, getWallet, getTransactionHistory, addFunds, deductFunds, setBalance, adjustDebt };
