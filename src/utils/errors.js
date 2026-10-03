/**
 * src/utils/errors.js
 *
 * WHAT THIS MODULE DOES
 * Defines the ApiError class and the factory functions used to throw errors
 * that carry an HTTP status code and a machine-readable code.
 *
 * WHY IT EXISTS
 * Route handlers and services should be able to say "throw ApiError.notFound()"
 * instead of manually building `const err = new Error(); err.status = 404`.
 * The central error middleware then only has to understand one shape.
 *
 * COMMUNICATION
 * Used by: controllers, services, validators, middleware.
 * Read by: src/middleware/error.middleware.js
 */
export class ApiError extends Error {
    /**
     * @param {string} message - Safe message to send to the client.
     * @param {number} status - HTTP status code.
     * @param {string} code - Stable machine-readable code, e.g. 'ROOM_NOT_FOUND'.
     * @param {object} [details] - Optional field-level details (validation).
     */
    constructor(message, status = 500, code = 'INTERNAL_ERROR', details = undefined) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }

    static badRequest(message = 'Bad request', code = 'BAD_REQUEST', details) {
        return new ApiError(message, 400, code, details);
    }

    static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
        return new ApiError(message, 401, code);
    }

    static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
        return new ApiError(message, 403, code);
    }

    static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
        return new ApiError(message, 404, code);
    }

    static conflict(message = 'Resource already exists', code = 'CONFLICT') {
        return new ApiError(message, 409, code);
    }

    /**
     * Payment required (HTTP 402).
     *
     * A declined card is not a validation error: the request was well formed
     * and the user may retry it. Giving it its own status lets the frontend
     * show the gateway's message and keep the card form filled in, instead of
     * treating it as a broken submission.
     */
    static paymentRequired(message = 'Payment could not be completed', code = 'PAYMENT_FAILED', details) {
        return new ApiError(message, 402, code, details);
    }

    static unprocessable(message = 'Validation failed', details) {
        return new ApiError(message, 422, 'VALIDATION_ERROR', details);
    }

    static tooManyRequests(message = 'Too many requests', code = 'RATE_LIMITED') {
        return new ApiError(message, 429, code);
    }

    static internal(message = 'An unexpected error occurred', code = 'INTERNAL_ERROR') {
        return new ApiError(message, 500, code);
    }
}

export default ApiError;