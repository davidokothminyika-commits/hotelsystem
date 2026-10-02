/**
 * public/js/api/api.js
 *
 * WHAT THIS MODULE DOES
 * The single HTTP client for the whole frontend. Every other API module calls
 * through this, so authentication, error handling and JSON parsing are
 * implemented once.
 *
 * WHY IT EXISTS
 * If each page wrote its own fetch() call, the cookie handling and error
 * behaviour would drift between pages, and a change would need to be repeated
 * everywhere. Centralising it means one place to reason about how the browser
 * talks to the API.
 *
 * AUTHENTICATION AND THE COOKIE
 * The session token is an HTTP-only cookie, so JavaScript cannot read it (that
 * is the point: an XSS bug cannot steal it). The browser attaches it
 * automatically, but only when the request is made with `credentials:
 * 'include'`. Omitting that flag is the single most common reason an
 * authenticated fetch appears to work in development and fail in production.
 *
 * COMMUNICATION
 * Every page script -> THIS FILE -> Express /api routes
 */

/** Base path for the API. Root-relative so it works from any page depth. */
const API_BASE = '/api';

/**
 * Error thrown for any non-2xx response.
 * Carries the HTTP status and the machine-readable code from the API so
 * callers can branch on something meaningful rather than on message text.
 */
export class ApiError extends Error {
    constructor(message, status, code, errors = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        // Field level validation messages, keyed by field name.
        this.errors = errors;
    }

    /** True when the request failed because the session is missing or expired. */
    get isAuthError() {
        return this.status === 401;
    }

    get isForbidden() {
        return this.status === 403;
    }

    get isValidationError() {
        return this.status === 422 || this.status === 400;
    }
}

/**
 * Called when any request returns 401.
 *
 * A tab left open overnight will have an expired token. Rather than showing a
 * broken page, the app returns the guest to sign in, remembering where they
 * were. Set by the shell so this module stays free of DOM logic.
 */
let onUnauthenticated = null;

export function setUnauthenticatedHandler(handler) {
    onUnauthenticated = handler;
}

/**
 * Builds a query string, dropping empty values so URLs stay clean.
 *
 * @param {object} params
 * @returns {string} e.g. '?page=2&limit=10'
 */
export function buildQuery(params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        search.append(key, String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : '';
}

/**
 * Performs a request against the API.
 *
 * @param {string} path   Path beginning with '/', e.g. '/rooms/availability'.
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body]      JSON body; omit for GET and DELETE.
 * @param {object} [options.query]     Query string parameters.
 * @param {boolean} [options.raw=false] Return the Response for uploads.
 * @returns {Promise<object>} The parsed `data` field of the response.
 * @throws {ApiError}
 */
export async function request(path, options = {}) {
    const { method = 'GET', body, query, raw = false, signal } = options;

    const url = `${API_BASE}${path}${buildQuery(query)}`;

    const config = {
        method,
        // Required for the auth cookie to travel with the request.
        credentials: 'include',
        headers: {
            Accept: 'application/json',
        },
        signal,
    };

    if (body !== undefined) {
        config.headers['Content-Type'] = 'application/json';
        config.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(url, config);
    } catch (error) {
        // fetch rejects only for network-level problems: the server is down,
        // DNS failed, or the request was aborted. A 4xx or 5xx still resolves.
        if (error.name === 'AbortError') throw error;
        throw new ApiError(
            'Could not reach the server. Check your connection and try again.',
            0,
            'NETWORK_ERROR',
        );
    }

    if (raw) return response;

    // A 204 or an empty body is a valid success with nothing to return.
    let payload = null;
    const text = await response.text();
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            // A non-JSON body usually means the server returned an HTML error
            // page, which is worth reporting clearly rather than crashing on.
            throw new ApiError(
                'The server returned an unexpected response.',
                response.status,
                'INVALID_RESPONSE',
            );
        }
    }

    if (!response.ok) {
        const apiError = new ApiError(
            payload?.message || 'Request failed. Please try again.',
            response.status,
            payload?.code || 'REQUEST_FAILED',
            payload?.errors || null,
        );

        // A 401 anywhere means the session is gone. Let the shell redirect
        // once, rather than each caller handling it separately.
        if (response.status === 401 && onUnauthenticated) {
            onUnauthenticated(apiError);
        }

        throw apiError;
    }

    // Return `data` directly so callers never repeat `.body.data`.
    return payload ? { data: payload.data, meta: payload.meta, message: payload.message, raw: payload } : null;
}

export const api = {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

export default api;