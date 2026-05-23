'use strict';

/**
 * Standardized API response helpers.
 * Controllers always return data through these — consistent shape across all endpoints.
 */

const sendSuccess = (res, data = null, message = 'Success', statusCode = 200) => {
    const response = { success: true, message };
    if (data !== null) response.data = data;
    return res.status(statusCode).json(response);
};

const sendCreated = (res, data, message = 'Resource created successfully') =>
    sendSuccess(res, data, message, 201);

const sendPaginated = (res, data, pagination, message = 'Success') => {
    return res.status(200).json({
        success: true,
        message,
        data,
        pagination,
    });
};

module.exports = { sendSuccess, sendCreated, sendPaginated };
