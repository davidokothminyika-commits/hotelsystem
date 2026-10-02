/**
 * src/middleware/error.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Terminal error handling for the whole API. Every error funnels through
 * `errorHandler`, which converts it into the standard failure envelope.
 *
 * WHY IT EXISTS
 * Without a central handler, each route would need its own try/catch and each
 * could leak a different amount of internal detail. Centralising this gives
 * three guarantees:
 *   1. Clients always receive `{ success: false, message, code }`.
 *   2. Stack traces and SQL fragments never reach the browser in production.
 *   3. Errors are logged once, server side, where developers can see them.
 *
 * ORDER MATTERS IN EXPRESS
 *   - `notFoundHandler` must be registered after all routes.
 *   - `errorHandler` must be registered last, after notFoundHandler.
 * Express identifies error middleware by its four argument signature, so the
 * unused `next` parameter must stay even though it is not called.
 *
 * COMMUNICATION
 * Used by: src/app.js (registered last).
 * Caught errors thrown by: controllers, services, repositories, validators.
 * Database tables used: none.
 */
import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/errors.js';
import { sendError } from '../utils/response.js';

/**
 * Handles requests that matched no route. Registered after every router.
 * For /api paths it returns JSON; for browser navigations it serves the
 * styled 404 page.
 */
export function notFoundHandler(req, res, next) {
    if (req.originalUrl.startsWith('/api/')) {
        return sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND', 404);
    }
    return res.status(404).sendFile('404.html', { root: 'public' });
}

/**
 * Converts known error types into safe client responses.
 *
 * @param {import('express').Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
    let error = err;

    // ---- Translate third party errors into ApiError -----------------------

    // express-validator errors arrive as an array of validation failures.
    if (Array.isArray(error) && error.every((item) => item && item.msg)) {
        const details = {};
        for (const item of error) {
            // Only expose the first message per field to keep responses small.
            if (!details[item.path]) details[item.path] = item.msg;
        }
        error = ApiError.unprocessable('Please correct the highlighted fields', details);
    }

    // Multer file upload failures (file too large, wrong type, etc).
    if (error instanceof multer.MulterError) {
        const message =
            error.code === 'LIMIT_FILE_SIZE'
                ? `File is too large. Maximum size is ${env.uploads.maxSizeMb}MB.`
                : `Upload failed: ${error.message}`;
        error = ApiError.badRequest(message, `UPLOAD_${error.code}`);
    }

    // Body parser rejects malformed JSON with a SyntaxError that has .body set.
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        error = ApiError.badRequest('Request body contains invalid JSON', 'INVALID_JSON');
    }

    // MySQL / MariaDB driver errors.
    if (error && typeof error === 'object' && 'code' in error) {
        switch (error.code) {
            case 'ER_DUP_ENTRY':
            case 'ER_DUP_KEY':
                error = ApiError.conflict('A record with those details already exists', 'DUPLICATE_ENTRY');
                break;
            case 'ER_NO_REFERENCED_ROW':
            case 'ER_NO_REFERENCED_ROW_2':
                error = ApiError.badRequest('Referenced record does not exist', 'INVALID_REFERENCE');
                break;
            case 'ER_ROW_IS_REFERENCED':
            case 'ER_ROW_IS_REFERENCED_2':
                error = ApiError.conflict(
                    'This record is referenced by other records and cannot be deleted',
                    'RECORD_IN_USE',
                );
                break;
            case 'ECONNREFUSED':
            case 'PROTOCOL_CONNECTION_LOST':
                error = new ApiError('Database is unavailable. Please try again shortly.', 503, 'DB_UNAVAILABLE');
                break;
            case 'ER_LOCK_DEADLOCK':
                error = ApiError.conflict('The request conflicted with another. Please retry.', 'DEADLOCK');
                break;
            default:
                break;
        }
    }

    // Anything that is not an ApiError is treated as a bug and hidden.
    const status = error instanceof ApiError ? error.status : error.status || 500;
    const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';

    // Log server side. In production we log the stack; in development we log
    // everything so the developer sees the cause immediately.
    if (status >= 500) {
        console.error(`[error] ${req.method} ${req.originalUrl}`, error);
    } else if (!env.isProduction) {
        console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${status} ${code}: ${error.message}`);
    }

    const message =
        status >= 500 && env.isProduction
            ? 'An unexpected error occurred. Please try again later.'
            : error.message || 'Request failed';

    const response = { success: false, message, code };
    if (error instanceof ApiError && error.details) {
        response.errors = error.details;
    }

    // If the client aborted (upload cancel, closed tab) there is nothing to send.
    if (res.headersSent) {
        return next(error);
    }

    return res.status(status).json(response);
}

/**
 * Wraps an async route handler so rejected promises reach `errorHandler`.
 *
 * WHY THIS EXISTS
 * Express 4 does not catch rejected promises from async functions. Without
 * this wrapper an async handler that throws would hang the request until it
 * timed out. With it, `throw` inside a controller works normally.
 *
 * Express 5 handles async rejections automatically, so this wrapper becomes
 * a no-op safety net rather than being removed.
 *
 * @param {Function} handler
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(handler) {
    return function wrapped(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

export default { notFoundHandler, errorHandler, asyncHandler };