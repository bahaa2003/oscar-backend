'use strict';

const { body } = require('express-validator');

const updateUserValidation = [
    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('groupId')
        .optional({ nullable: true })
        .custom((value) => {
            if (value === null) return true;
            const mongoose = require('mongoose');
            if (!mongoose.Types.ObjectId.isValid(value)) {
                throw new Error('Invalid group ID format');
            }
            return true;
        }),

    body('creditLimit')
        .optional()
        .isFloat({ min: 0 }).withMessage('Credit limit must be a non-negative number'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),
];

module.exports = { updateUserValidation };
