/**
 * src/middleware/apiKeyAuth.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Authenticates machine-to-machine requests with an `x-api-key` header.
 *
 * WHY IT IS SEPARATE FROM requireAuth
 * requireAuth answers "which person is this?", and everything downstream of
 * it assumes `req.user` exists and points at a user row. An API key
 * authenticates a *system*: there is no user row, no session, no cookie, and
 * no permission table to consult - only a read-only surface, by design. The
 * two middleware therefore set different request properties and guard
 * different routers, and one falling back to the other would quietly widen
 * what a key can reach or what a person can reach.
 *
 * WHY 401 RATHER THAN 403 ON A BAD KEY
 * An unauthenticated machine has no business knowing whether a valid key
 * would have been allowed to see the resource, exactly like the user path.
 *
 * COMMUNICATION
 * Used by: src/routes/external.routes.js
 * Reads:   services/apiKey.service.js (verify)
 * Sets:    req.apiKey { id, name, keyPrefix }
 */
import apiKeyService from '../services/apiKey.service.js';
import ApiError from '../utils/errors.js';

/** Extracts the presented key from the header (or, for convenience, the query). */
function presentedKey(req) {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    if (typeof req.query.apiKey === 'string' && req.query.apiKey.trim()) {
        // GET-only convenience: a key in a URL is logged by proxies, so this
        // path exists purely for quick manual checks and is discouraged on
        // anything sensitive. The middleware only ever guards read endpoints.
        return req.query.apiKey.trim();
    }
    return null;
}

/**
 * Guards a route (or router) so only a valid, active API key passes.
 *
 * @example router.get('/', requireApiKey, handler)
 */
export function requireApiKey(req, res, next) {
    const key = presentedKey(req);
    if (!key) {
        return next(ApiError.unauthorized(
            'Provide your API key in the x-api-key header',
            'API_KEY_REQUIRED',
        ));
    }

    apiKeyService
        .verify(key)
        .then((verified) => {
            if (!verified) {
                return next(ApiError.unauthorized('API key is invalid or has been revoked', 'INVALID_API_KEY'));
            }
            req.apiKey = verified;
            return next();
        })
        .catch(next);
}

export default { requireApiKey };
