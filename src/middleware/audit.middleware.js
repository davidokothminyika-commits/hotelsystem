/**
 * src/middleware/audit.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Records security relevant actions (logins, booking changes, payment,
 * admin actions) into the `audit_logs` table.
 *
 * WHY IT EXISTS
 * Hotels handle guest data and money, so "who changed this and when" must be
 * answerable after the fact. Auditing inside controllers is easy to forget;
 * a middleware applied to a route guarantees the entry exists.
 *
 * DESIGN DECISION: NEVER THROW
 * An audit failure must never break the operation the guest asked for. If the
 * audit insert fails we log to the console and continue, because refusing a
 * booking because the log table is full would be worse than the missing entry.
 *
 * COMMUNICATION
 * Used by: routes (logAction) and services (auditLog.record).
 * Database tables used: audit_logs.
 */
import auditLogService from '../services/audit.service.js';

/**
 * Best effort audit write. Never throws.
 *
 * @param {object} entry
 * @param {number|null} entry.userId
 * @param {string} entry.action e.g. 'booking.created'
 * @param {string} [entry.entity]
 * @param {string|number} [entry.entityId]
 * @param {import('express').Request} entry.req Used for IP address and user agent
 * @param {object} [entry.metadata]
 */
export async function recordAudit({ userId, action, entity, entityId, req, metadata }) {
    try {
        await auditLogService.record({
            userId: userId ?? null,
            action,
            entity: entity ?? null,
            entityId: entityId !== undefined && entityId !== null ? String(entityId) : null,
            ipAddress: req ? extractIp(req) : null,
            userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 255) : null,
            metadata: metadata ?? null,
        });
    } catch (error) {
        // Never let auditing break the request.
        console.error(`[audit] Failed to record "${action}":`, error.message);
    }
}

/**
 * Reads the client IP, trusting X-Forwarded-For only when present.
 * Note: in production behind a reverse proxy, Express must be configured
 * with `app.set('trust proxy', ...)` for this to be accurate.
 */
export function extractIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // The left-most entry is the original client.
        const first = String(forwarded).split(',')[0].trim();
        if (first) return first.slice(0, 45);
    }
    return (req.ip || req.socket?.remoteAddress || '').slice(0, 45);
}

/**
 * Logs one fixed action for every request that reaches this route.
 *
 * @param {string} action
 * @param {(req: import('express').Request) => object} [extract]
 *   Pulls entity/entityId/metadata from the request.
 * @example
 *   router.post('/', requireAuth, auditAction('review.created', (req) => ({
 *       entity: 'review', metadata: { entity_type: req.body.entity_type }
 *   })), asyncHandler(createReview));
 */
export function auditAction(action, extract = () => ({})) {
    return async function auditMiddleware(req, res, next) {
        // Run after the handler so we capture the resource id it created.
        res.on('finish', () => {
            if (res.statusCode >= 400) return; // Only record successful actions.
            const extracted = extract(req) || {};
            recordAudit({
                userId: req.user?.id ?? null,
                action,
                entity: extracted.entity,
                entityId: extracted.entityId ?? extracted.id ?? res.locals.auditEntityId,
                req,
                metadata: extracted.metadata,
            });
        });
        return next();
    };
}

/**
 * Records a failed login.
 *
 * Called directly rather than via auditAction because a failed login has no
 * authenticated user and returns 401, which auditAction deliberately skips.
 * The userId is resolved from the submitted email when possible.
 */
export async function recordFailedLogin({ email, req, reason }) {
    try {
        const user = await auditLogService.findUserIdByEmail(email);
        await auditLogService.record({
            userId: user,
            action: 'auth.login_failed',
            entity: 'users',
            entityId: user,
            ipAddress: extractIp(req),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 255),
            metadata: { email: String(email || '').slice(0, 190), reason },
        });
    } catch (error) {
        console.error('[audit] Failed to record failed login:', error.message);
    }
}

export default { recordAudit, auditAction, extractIp, recordFailedLogin };