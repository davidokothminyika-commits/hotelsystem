/**
 * src/middleware/rateLimit.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Limits how many requests a client may make, protecting expensive endpoints
 * such as login and password reset from brute force attacks.
 *
 * WHY IT EXISTS
 * Authentication endpoints are the most attacked surface in any web app. An
 * attacker can try thousands of passwords per minute unless something slows
 * them down. A general limiter also protects the database by discouraging
 * runaway scripts.
 *
 * HOW IT WORKS
 * express-rate-limit keeps an in-memory counter keyed by IP inside a sliding
 * window. This is deliberately simple: it is correct for a single-process
 * local deployment. A multi-server deployment would move the store to Redis,
 * which is a configuration change rather than a rewrite.
 *
 * IMPORTANT SECURITY NOTE
 * When the limiter rejects a request it responds with a generic message. It
 * must never reveal whether an email address exists, and it never logs the
 * submitted credentials.
 *
 * COMMUNICATION
 * Used by: src/app.js (global) and src/routes/auth.routes.js (strict).
 * Database tables used: none.
 */
import rateLimit from 'express-rate-limit';
import env from '../config/env.js';
import ApiError from '../utils/errors.js';
import { sendError } from '../utils/response.js';

const windowMs = env.rateLimit.windowMinutes * 60 * 1000;

/**
 * In the test environment the ceilings are effectively removed, because a
 * test suite legitimately performs hundreds of logins in a few seconds and
 * would otherwise fail on rate limiting rather than on real behaviour.
 *
 * This does NOT weaken production: the branch only applies when
 * NODE_ENV=test, and the limiter itself is still exercised explicitly by
 * tests/security.test.js using a dedicated instance with a low ceiling.
 */
const EFFECTIVE_MAX = env.isTest ? Number.MAX_SAFE_INTEGER : env.rateLimit.max;
const EFFECTIVE_AUTH_MAX = env.isTest ? Number.MAX_SAFE_INTEGER : env.rateLimit.authMax;

function handleLimitExceeded(_req, res) {
    return sendError(
        res,
        'Too many requests. Please wait a few minutes and try again.',
        'RATE_LIMITED',
        429,
    );
}

/**
 * Broad limiter applied to the whole /api surface.
 */
export const apiLimiter = rateLimit({
    windowMs,
    max: EFFECTIVE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // Successful reads should never be penalised, so only failures count.
    skipSuccessfulRequests: true,
    handler: handleLimitExceeded,
});

/**
 * Strict limiter for credential endpoints: login, register, forgot password.
 * A much lower ceiling makes online password guessing impractical.
 */
export const authLimiter = rateLimit({
    windowMs,
    max: EFFECTIVE_AUTH_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // Every login attempt counts, including successful ones, so an attacker
    // cannot reset the counter by interleaving valid credentials.
    skipSuccessfulRequests: false,
    handler: handleLimitExceeded,
});

/**
 * Single-use limiter for sending email: password resets and verification
 * mail. Without this, anyone could use the mailer to spam an inbox.
 */
export const emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // one hour
    max: env.isTest ? Number.MAX_SAFE_INTEGER : 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) =>
        sendError(
            res,
            'Too many email requests. Please try again later.',
            'EMAIL_RATE_LIMITED',
            429,
        ),
});

/**
 * Builds a limiter with an explicit ceiling.
 * Exported so tests can verify the limiter's behaviour with a low threshold
 * rather than relying on the production configuration.
 */
export function createLimiter({ max, windowMs: customWindow = 60_000 } = {}) {
    return rateLimit({
        windowMs: customWindow,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: handleLimitExceeded,
    });
}

/**
 * Write limiter. A guest creating fifty bookings in a minute is a bug or an
 * abuse script, never a legitimate user.
 */
export const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: env.isTest ? Number.MAX_SAFE_INTEGER : 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) =>
        sendError(res, 'You are making requests too quickly. Please slow down.', 'WRITE_RATE_LIMITED', 429),
});

export { ApiError };
export default { apiLimiter, authLimiter, emailLimiter, writeLimiter };