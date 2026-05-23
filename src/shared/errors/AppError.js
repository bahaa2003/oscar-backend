'use strict';

/**
 * Base application error — all custom errors extend this.
 */
class AppError extends Error {
    constructor(message, statusCode, code = null) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;         // Machine-readable code e.g. 'INSUFFICIENT_FUNDS'
        this.isOperational = true; // Distinguishes known errors from programmer bugs
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message, errors = []) {
        super(message, 400, 'VALIDATION_ERROR');
        this.errors = errors;
    }
}

class AuthenticationError extends AppError {
    constructor(message = 'Authentication failed') {
        super(message, 401, 'AUTHENTICATION_ERROR');
    }
}

class AuthorizationError extends AppError {
    constructor(message = 'You do not have permission to perform this action') {
        super(message, 403, 'AUTHORIZATION_ERROR');
    }
}

class NotFoundError extends AppError {
    constructor(resource = 'Resource') {
        super(`${resource} not found`, 404, 'NOT_FOUND');
    }
}

class ConflictError extends AppError {
    constructor(message) {
        super(message, 409, 'CONFLICT');
    }
}

class InsufficientFundsError extends AppError {
    constructor(required, available) {
        super(
            `Insufficient funds. Required: ${required}, Available: ${available}`,
            422,
            'INSUFFICIENT_FUNDS'
        );
        this.required = required;
        this.available = available;
    }
}

class BusinessRuleError extends AppError {
    constructor(message, code = 'BUSINESS_RULE_VIOLATION') {
        super(message, 422, code);
    }
}

module.exports = {
    AppError,
    ValidationError,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    ConflictError,
    InsufficientFundsError,
    BusinessRuleError,
};
