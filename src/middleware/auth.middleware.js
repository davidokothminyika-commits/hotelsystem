/**
 * src/middleware/auth.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Verifies the JWT from the request and attaches the authenticated user to
 * `req.user`. Also provides optional authentication and role guards.
 *
 * WHY IT EXISTS
 * Authentication logic must be identical on every protected route. Writing it
 * once means there is a single place to audit for mistakes.
 *
 * HOW IT WORKS
 *   Browser (fetch, credentials: 'include')
 *      -> Express cookie-parser populates req.cookies
 *      -> we read the token from the cookie, falling back to the
 *         Authorization header for non-browser clients and tests
 *      -> verify the signature and expiry
 *      -> load the user from the database
 *      -> confirm the account is still active
 *      -> set req.user = { id, role, email, firstName, lastName }
 *
 * WHY THE USER IS LOADED FROM THE DATABASE
 * A valid signature only proves the token was issued by us. It does not prove
 * the account is still active or that its role has not changed. Re-reading
 * the user means deactivating an account or revoking a role takes effect on
 * the next request instead of when the token happens to expire.
 *
 * COMMUNICATION
 * Used by: every protected route via `requireAuth` / `optionalAuth`.
 * Reads:   utils/tokens.js for verification.
 * Database tables used: users, roles.
 */
import ApiError from '../utils/errors.js';
import { verifyAccessToken } from '../utils/tokens.js';
import userRepository from '../repositories/user.repository.js';

export const AUTH_COOKIE_NAME = 'hotel_token';

/**
 * Pulls the JWT out of the request.
 *
 * The cookie is the primary channel because it is HTTP-only, so JavaScript
 * (including any injected script) cannot read the token. The Authorization
 * header remains supported for Postman, curl and the automated tests.
 */
function extractToken(req) {
    if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
        return req.cookies[AUTH_COOKIE_NAME];
    }

    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        return header.slice(7).trim();
    }

    return null;
}

/**
 * Loads the user record for a verified token payload.
 * Throws if the account was deleted, deactivated, or the role changed.
 */
async function resolveUser(payload) {
    const user = await userRepository.findById(payload.id);

    if (!user) {
        throw ApiError.unauthorized('Account no longer exists', 'ACCOUNT_NOT_FOUND');
    }

    // The repository maps DB rows to camelCase (`isActive`), so this must use
    // the mapped name rather than the raw column `is_active`.
    if (!user.isActive) {
        throw ApiError.forbidden('Your account has been deactivated. Contact support.', 'ACCOUNT_DISABLED');
    }

    return user;
}

/**
 * Requires a valid token. Rejects with 401 when missing or invalid.
 */
export async function requireAuth(req, res, next) {
    try {
        const token = extractToken(req);

        if (!token) {
            throw ApiError.unauthorized('You must be signed in to continue', 'NO_TOKEN');
        }

        let payload;
        try {
            payload = verifyAccessToken(token);
        } catch (error) {
            // Expired and malformed tokens are both normal here (the user may
            // simply have left the tab open for a long time).
            if (error.name === 'TokenExpiredError') {
                throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
            }
            throw ApiError.unauthorized('Invalid authentication token', 'INVALID_TOKEN');
        }

        req.user = await resolveUser(payload);
        return next();
    } catch (error) {
        return next(error);
    }
}

/**
 * Attaches the user when a valid token is present, but never rejects.
 *
 * Used on public endpoints such as the home page or room list, so the UI can
 * personalise itself (show "My bookings" in the header) for signed in guests
 * while remaining fully usable for anonymous visitors.
 */
export async function optionalAuth(req, res, next) {
    try {
        const token = extractToken(req);
        if (!token) return next();

        const payload = verifyAccessToken(token);
        req.user = await resolveUser(payload);
    } catch {
        // An invalid token is treated as "not signed in" on public routes.
        req.user = null;
    }
    return next();
}

export default { requireAuth, optionalAuth, AUTH_COOKIE_NAME };