/**
 * src/services/webhook.service.js
 *
 * WHAT THIS MODULE DOES
 * Outbound event delivery: an endpoint subscribes to named events, and every
 * matching hotel event is queued and pushed to it, signed so the receiver can
 * prove where it came from.
 *
 * HOW DELIVERY WORKS
 *   1. `emit(event, payload)` finds active subscriptions for that event and
 *      writes one queued delivery row per endpoint (dead letter = the row,
 *      not the request that triggered it).
 *   2. A flusher passes over the queue, POSTing the JSON payload with
 *      `x-webhook-signature` (HMAC-SHA256 of the raw body with the endpoint's
 *      secret) and `x-webhook-event` headers.
 *   3. A 2xx response marks the row delivered; anything else (including a
 *      network error or a timeout) keeps it pending with an attempt count and
 *      the failure reason, and it is retried with backoff.
 *
 * WHY A QUEUE RATHER THAN A FIRE-AND-FORGET FETCH
 * A CRM that is down for five minutes would silently lose every booking made
 * in that window, and nobody would ever know which ones. A queued row keeps
 * the payload, the response code and the error until it succeeds - which is
 * what turns "the integration stopped working" into a one-click replay.
 *
 * RETRY POLICY
 * Backoff of attempt^2 * 5 seconds, capped at one hour, with a maximum of 8
 * attempts. Deliberately in-process rather than cron: the queue is short, the
 * interval keeps latency low, and the delivery table is the durable record if
 * the process dies (the flusher resumes nothing lost because nothing was ever
 * unqueued).
 *
 * COMMUNICATION
 * emit(): booking.service.js, payment.service.js, order.service.js,
 *         maintenance.service.js
 * CRUD:   webhook.controller.js
 * Database tables used: webhook_endpoints, webhook_deliveries
 */
import crypto from 'node:crypto';
import { query, queryOne, execute } from '../config/db.js';

/** Every event name the schema's SET column knows. Keep in step with it. */
export const WEBHOOK_EVENTS = Object.freeze([
    'booking.created',
    'booking.confirmed',
    'booking.checked_in',
    'booking.checked_out',
    'booking.cancelled',
    'payment.completed',
    'payment.refunded',
    'order.created',
    'maintenance.ticket_created',
    'maintenance.ticket_resolved',
    'ping',
]);

const MAX_ATTEMPTS = 8;
const FLUSH_INTERVAL_MS = 10_000;

/**
 * Signs a raw payload body.
 * The receiver hashes the exact bytes it received - not a re-serialised
 * object, whose key order could differ - so signing happens before anything
 * touches the payload again.
 */
function sign(secret, rawBody) {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * POSTs with a hard timeout.
 * A receiving endpoint that accepts connections and never answers would hang
 * the flusher forever without this; undici's AbortSignal applies to the whole
 * exchange, body included.
 */
async function postJson(url, rawBody, headers, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: rawBody,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

const webhookService = {
    // ------------------------------------------------------------------
    // Endpoint management (called from the controller)
    // ------------------------------------------------------------------

    /**
     * Registers a subscription. Returns the generated secret ONCE - the only
     * moment it is ever visible, mirroring how the API keys module shows its
     * full token exactly once.
     */
    async createEndpoint({ url, description, events }, requester) {
        const secret = crypto.randomBytes(32).toString('hex');

        const result = await execute(
            `INSERT INTO webhook_endpoints (url, description, events, secret, created_by)
             VALUES (:url, :description, :events, :secret, :createdBy)`,
            {
                url,
                description: description || null,
                events: events.join(','),
                secret,
                createdBy: requester.id,
            },
        );

        return {
            endpoint: await this.getEndpoint(result.insertId),
            // Shown once in the creation response, then never again.
            secret,
        };
    },

    async getEndpoint(id) {
        const row = await queryOne(
            `SELECT w.id, w.url, w.description, w.events, w.is_active,
                    w.created_by,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    w.created_at
             FROM webhook_endpoints w
             LEFT JOIN users u ON u.id = w.created_by
             WHERE w.id = :id`,
            { id },
        );
        if (!row) return null;
        return this.mapEndpoint(row);
    },

    mapEndpoint(row) {
        return {
            id: row.id,
            url: row.url,
            description: row.description,
            events: row.events ? row.events.split(',').filter(Boolean) : [],
            isActive: Number(row.is_active) === 1,
            createdBy: row.created_by,
            createdByName: row.created_by_name || null,
            createdAt: row.created_at,
        };
    },

    async listEndpoints() {
        const rows = await query(
            `SELECT w.id, w.url, w.description, w.events, w.is_active,
                    w.created_by,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    w.created_at,
                    (SELECT COUNT(*) FROM webhook_deliveries d
                      WHERE d.endpoint_id = w.id AND d.status = 'failed') AS failed_count,
                    (SELECT COUNT(*) FROM webhook_deliveries d
                      WHERE d.endpoint_id = w.id AND d.status = 'pending') AS pending_count
             FROM webhook_endpoints w
             LEFT JOIN users u ON u.id = w.created_by
             ORDER BY w.created_at DESC`,
        );
        return rows.map((row) => ({
            ...this.mapEndpoint(row),
            failedCount: Number(row.failed_count),
            pendingCount: Number(row.pending_count),
        }));
    },

    async updateEndpoint(id, { description, events, isActive }) {
        await execute(
            `UPDATE webhook_endpoints SET
                description = COALESCE(:description, description),
                events = COALESCE(:events, events),
                is_active = COALESCE(:isActive, is_active)
             WHERE id = :id`,
            {
                id,
                description: description ?? null,
                events: Array.isArray(events) ? events.join(',') : null,
                isActive: isActive === undefined ? null : (isActive ? 1 : 0),
            },
        );
        return this.getEndpoint(id);
    },

    async deleteEndpoint(id) {
        const endpoint = await this.getEndpoint(id);
        if (!endpoint) return null;
        await execute('DELETE FROM webhook_endpoints WHERE id = :id', { id });
        return endpoint;
    },

    // ------------------------------------------------------------------
    // Emitting and delivering
    // ------------------------------------------------------------------

    /**
     * Queues one delivery row per matching endpoint. Never throws: outbound
     * notifications must not be able to break the business operation that
     * caused them (a webhook being down cannot un-book a room).
     *
     * @param {string} event One of WEBHOOK_EVENTS.
     * @param {object} payload JSON-serialisable event data.
     */
    async emit(event, payload) {
        if (!WEBHOOK_EVENTS.includes(event)) {
            console.error(`[webhook] Unknown event "${event}" - not emitted`);
            return;
        }

        try {
            // FIND_IN_SET matches inside the SET column's comma list; the
            // plain equality left over from the schema's exact-value case is
            // unnecessary because FIND_IN_SET covers it.
            const endpoints = await query(
                `SELECT id FROM webhook_endpoints
                 WHERE is_active = 1
                   AND FIND_IN_SET(:event, events)`,
                { event },
            );

            for (const endpoint of endpoints) {
                await execute(
                    `INSERT INTO webhook_deliveries (endpoint_id, event, payload, status)
                     VALUES (:endpointId, :event, :payload, 'pending')`,
                    { endpointId: endpoint.id, event, payload: JSON.stringify({ event, data: payload }) },
                );
            }

            if (endpoints.length > 0) {
                // Fire and forget: the flusher also runs on its own interval,
                // so a failed schedule only means latency, not loss.
                this.flush().catch((error) =>
                    console.error('[webhook] Flush failed:', error.message),
                );
            }
        } catch (error) {
            console.error(`[webhook] Failed to queue "${event}":`, error.message);
        }
    },

    /**
     * One pass over due pending deliveries, delivered sequentially.
     *
     * Sequential rather than parallel caps the burst an integration outage
     * generates on recovery, and keeps this method simple enough to audit.
     */
    async flush() {
        // A row is due when it has never been tried, or when its backoff has
        // elapsed. Backoff grows quadratically (25s, 100s, 225s...) and stops
        // at an hour, so a dead endpoint is retried at a humane pace without
        // ever being forgotten until the table is retired.
        const due = await query(
            `SELECT d.id, d.endpoint_id, d.event, d.payload, d.attempts, w.url, w.secret
             FROM webhook_deliveries d
             JOIN webhook_endpoints w ON w.id = d.endpoint_id
             WHERE d.status = 'pending'
               AND w.is_active = 1
               AND d.attempts < :maxAttempts
               AND (d.attempts = 0
                    OR d.updated_at < DATE_SUB(NOW(), INTERVAL LEAST(
                        POW(GREATEST(d.attempts, 1) * 5, 2), 3600) SECOND))
             ORDER BY d.created_at ASC
             LIMIT 50`,
            { maxAttempts: MAX_ATTEMPTS },
        );

        for (const delivery of due) {
            await this.attempt(delivery);
        }

        return due.length;
    },

    /** Delivers one queued row and records the outcome. Never throws. */
    async attempt(delivery) {
        const rawBody = typeof delivery.payload === 'string'
            ? delivery.payload
            : JSON.stringify(delivery.payload);

        const headers = {
            'x-webhook-event': delivery.event,
            'x-webhook-signature': sign(delivery.secret, rawBody),
        };

        const nextAttempts = Number(delivery.attempts) + 1;

        try {
            const response = await postJson(delivery.url, rawBody, headers);

            if (response.status >= 200 && response.status < 300) {
                await execute(
                    `UPDATE webhook_deliveries
                     SET status = 'delivered', attempts = :attempts,
                         response_status = :responseStatus, last_error = NULL,
                         delivered_at = NOW()
                     WHERE id = :id`,
                    { id: delivery.id, attempts: nextAttempts, responseStatus: response.status },
                );
                return true;
            }

            await execute(
                `UPDATE webhook_deliveries
                 SET attempts = :attempts, response_status = :responseStatus,
                     last_error = :lastError,
                     status = IF(:attempts >= :maxAttempts, 'failed', 'pending')
                 WHERE id = :id`,
                {
                    id: delivery.id,
                    attempts: nextAttempts,
                    responseStatus: response.status,
                    lastError: `HTTP ${response.status}`.slice(0, 500),
                    maxAttempts: MAX_ATTEMPTS,
                },
            );
        } catch (error) {
            await execute(
                `UPDATE webhook_deliveries
                 SET attempts = :attempts,
                     last_error = :lastError,
                     status = IF(:attempts >= :maxAttempts, 'failed', 'pending')
                 WHERE id = :id`,
                {
                    id: delivery.id,
                    attempts: nextAttempts,
                    lastError: (error.message || 'Network error').slice(0, 500),
                    maxAttempts: MAX_ATTEMPTS,
                },
            );
        }

        return false;
    },

    /** Re-queues every failed delivery for one endpoint. */
    async retryFailed(endpointId) {
        const result = await execute(
            `UPDATE webhook_deliveries
             SET status = 'pending', attempts = 0, last_error = NULL
             WHERE endpoint_id = :endpointId AND status = 'failed'`,
            { endpointId },
        );
        return result.affectedRows;
    },

    /**
     * Recent deliveries, newest first, filtered to one endpoint optionally.
     * The integrations screen shows this record rather than asking the user to
     * trust that pushes "just work".
     */
    async listDeliveries({ endpointId, status, limit = 50 } = {}) {
        const params = { limit: Math.min(200, Math.max(1, Number(limit) || 50)) };
        const conditions = [];

        if (endpointId) {
            conditions.push('d.endpoint_id = :endpointId');
            params.endpointId = endpointId;
        }
        if (status) {
            conditions.push('d.status = :status');
            params.status = status;
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = await query(
            `SELECT d.id, d.endpoint_id, d.event, d.status, d.attempts,
                    d.response_status, d.last_error, d.delivered_at, d.created_at,
                    w.url AS endpoint_url
             FROM webhook_deliveries d
             JOIN webhook_endpoints w ON w.id = d.endpoint_id
             ${where}
             ORDER BY d.created_at DESC
             LIMIT :limit`,
            params,
        );

        return rows.map((row) => ({
            id: row.id,
            endpointId: row.endpoint_id,
            endpointUrl: row.endpoint_url,
            event: row.event,
            status: row.status,
            attempts: Number(row.attempts),
            responseStatus: row.response_status ?? null,
            lastError: row.last_error ?? null,
            deliveredAt: row.delivered_at,
            createdAt: row.created_at,
        }));
    },

    /**
     * Sends a signed ping through the real delivery path, so testing an
     * endpoint exercises exactly what production traffic exercises.
     */
    async sendPing(endpointId) {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) return null;

        await execute(
            `INSERT INTO webhook_deliveries (endpoint_id, event, payload, status)
             VALUES (:endpointId, 'ping', :payload, 'pending')`,
            {
                endpointId,
                payload: JSON.stringify({
                    event: 'ping',
                    data: { sentAt: new Date().toISOString(), message: 'Endpoint test' },
                }),
            },
        );

        // The row is delivered immediately rather than waiting for the next
        // flush tick, so the person clicking Test sees the result now.
        const queued = await queryOne(
            'SELECT * FROM webhook_deliveries WHERE endpoint_id = :id AND event = \'ping\' ORDER BY id DESC LIMIT 1',
            { id: endpointId },
        );
        const ok = await this.attempt(queued);
        return { delivered: ok, delivery: await this.listDeliveries({ endpointId, limit: 1 }) };
    },

    /**
     * Starts the in-process flusher.
     * setInterval is deliberately unref'd: a dying process must not be kept
     * alive by its retry loop.
     */
    startFlusher() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            this.flush().catch((error) =>
                console.error('[webhook] Background flush failed:', error.message),
            );
        }, FLUSH_INTERVAL_MS);
        this._timer.unref?.();
    },

    stopFlusher() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },
};

export default webhookService;
