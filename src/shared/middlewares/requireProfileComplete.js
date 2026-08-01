'use strict';

const { AuthorizationError } = require('../errors/AppError');
const { getMissingProfileFields } = require('../../modules/auth/auth.service');

const requireProfileComplete = (req, _res, next) => {
    const missingProfileFields = getMissingProfileFields(req.user);
    if (req.user?.googleId && missingProfileFields.length > 0) {
        const error = new AuthorizationError('Profile completion is required before accessing this resource.');
        error.code = 'PROFILE_COMPLETION_REQUIRED';
        error.missingProfileFields = missingProfileFields;
        throw error;
    }
    next();
};

module.exports = requireProfileComplete;
