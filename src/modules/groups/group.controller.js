'use strict';

const groupService = require('./group.service');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// ─── Create ───────────────────────────────────────────────────────────────────

const createGroup = catchAsync(async (req, res) => {
    const { name, percentage, billingMode } = req.body;
    const group = await groupService.createGroup({ name, percentage, billingMode });
    sendCreated(res, group, 'Group created successfully.');
});

// ─── Read ─────────────────────────────────────────────────────────────────────

const listGroups = catchAsync(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const groups = await groupService.listGroups({ includeInactive });
    sendSuccess(res, groups, 'Groups retrieved successfully.');
});

const getGroup = catchAsync(async (req, res) => {
    const group = await groupService.getGroupById(req.params.id);
    sendSuccess(res, group);
});

// ─── Update Group Percentage ──────────────────────────────────────────────────

/**
 * PATCH /api/groups/:id/percentage
 * Updates the markup percentage of a group.
 * Only affects future price calculations — no retroactive changes to orders.
 */
const updateGroupPercentage = catchAsync(async (req, res) => {
    const group = await groupService.updateGroupPercentage(
        req.params.id,
        parseFloat(req.body.percentage)
    );
    sendSuccess(res, group, 'Group percentage updated. Affects future price calculations only.');
});

/**
 * PATCH /api/groups/:id
 * General group update (name, percentage, isActive).
 */
const updateGroup = catchAsync(async (req, res) => {
    const { name, percentage, isActive, billingMode } = req.body;
    const group = await groupService.updateGroup(req.params.id, {
        name,
        percentage: percentage !== undefined ? parseFloat(percentage) : undefined,
        isActive,
        billingMode,
    });
    sendSuccess(res, group, 'Group updated successfully.');
});

// ─── Change User Group ────────────────────────────────────────────────────────

/**
 * PATCH /api/groups/users/:userId
 * Move a customer to a different pricing group.
 */
const changeUserGroup = catchAsync(async (req, res) => {
    const { userId } = req.params;
    const { groupId } = req.body;
    const user = await groupService.changeUserGroup(userId, groupId);
    sendSuccess(res, user, 'User group updated successfully.');
});

module.exports = {
    createGroup,
    listGroups,
    getGroup,
    updateGroupPercentage,
    updateGroup,
    changeUserGroup,
};
