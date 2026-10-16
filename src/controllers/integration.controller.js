/**
 * src/controllers/integration.controller.js
 *
 * WHAT THIS MODULE DOES
 * Administration of the open-API surface: API keys for third-party systems
 * and webhook endpoints plus their delivery history.
 *
 * THE ONE-TIME SECRET RULE
 * A webhook signing secret and an API key each exist in plaintext for exactly
 * one response - their creation. Every later read returns only the prefix, so
 * nobody can configure a client from a screenshot of the admin panel.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services (apiKey, webhook)
 * Frontend: public/js/pages/admin/integrations.js
 */
import { sendSuccess, sendCreated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import { WEBHOOK_EVENTS } from '../services/webhook.service.js';
import apiKeyService from '../services/apiKey.service.js';
import webhookService from '../services/webhook.service.js';

const integrationController = {
    // ------------------------------------------------------------------
    // API keys
    // ------------------------------------------------------------------

    /** GET /api/integrations/api-keys */
    listKeys: asyncHandler(async (_req, res) => {
        const apiKeys = await apiKeyService.listKeys();
        return sendSuccess(res, 'API keys retrieved', { apiKeys });
    }),

    /**
     * POST /api/integrations/api-keys
     * The response body is the one and only place the full key appears.
     */
    createKey: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;

        const { apiKey, key } = await apiKeyService.createKey(payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.API_KEY_CREATED,
            entity: 'api_keys',
            entityId: apiKey.id,
            req,
            metadata: { key_name: apiKey.name, key_prefix: apiKey.keyPrefix },
        });

        return sendCreated(res, 'API key created - copy it now, it will not be shown again', {
            apiKey,
            key,
        });
    }),

    /** POST /api/integrations/api-keys/:id/revoke */
    revokeKey: asyncHandler(async (req, res) => {
        const apiKey = await apiKeyService.revoke(req.params.id);

        if (!apiKey) {
            return res.status(404).json({
                success: false,
                message: 'API key not found',
                code: 'API_KEY_NOT_FOUND',
            });
        }

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.API_KEY_REVOKED,
            entity: 'api_keys',
            entityId: apiKey.id,
            req,
            metadata: { key_prefix: apiKey.keyPrefix, key_name: apiKey.name },
        });

        return sendSuccess(res, 'API key revoked', { apiKey });
    }),

    // ------------------------------------------------------------------
    // Webhook endpoints
    // ------------------------------------------------------------------

    /** GET /api/integrations/webhooks */
    listWebhooks: asyncHandler(async (_req, res) => {
        const webhooks = await webhookService.listEndpoints();
        return sendSuccess(res, 'Webhook endpoints retrieved', { webhooks });
    }),

    /** GET /api/integrations/webhooks/events - what an endpoint may subscribe to */
    listEvents: asyncHandler(async (_req, res) => {
        return sendSuccess(res, 'Webhook events retrieved', { events: WEBHOOK_EVENTS });
    }),

    /** POST /api/integrations/webhooks - the signing secret is returned once */
    createWebhook: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;

        const { endpoint, secret } = await webhookService.createEndpoint(payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.WEBHOOK_CREATED,
            entity: 'webhook_endpoints',
            entityId: endpoint.id,
            req,
            metadata: { url: endpoint.url, events: endpoint.events },
        });

        return sendCreated(res, 'Webhook endpoint created, with its signing secret', {
            endpoint,
            secret,
        });
    }),

    /** PATCH /api/integrations/webhooks/:id */
    updateWebhook: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const endpoint = await webhookService.updateEndpoint(req.params.id, payload);

        return sendSuccess(res, 'Webhook endpoint updated', { endpoint });
    }),

    /** DELETE /api/integrations/webhooks/:id */
    deleteWebhook: asyncHandler(async (req, res) => {
        const endpoint = await webhookService.deleteEndpoint(req.params.id);

        if (!endpoint) {
            return res.status(404).json({
                success: false,
                message: 'Webhook endpoint not found',
                code: 'WEBHOOK_NOT_FOUND',
            });
        }

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.WEBHOOK_DELETED,
            entity: 'webhook_endpoints',
            entityId: endpoint.id,
            req,
            metadata: { url: endpoint.url },
        });

        return sendSuccess(res, 'Webhook endpoint deleted', { endpoint });
    }),

    /**
     * POST /api/integrations/webhooks/:id/test
     * Sends a signed ping through the real delivery path so the operator can
     * see the endpoint answer. Returns whether it was delivered, not whether
     * clicking succeeded - a failed handshake is a valid result.
     */
    testWebhook: asyncHandler(async (req, res) => {
        const result = await webhookService.sendPing(req.params.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Webhook endpoint not found',
                code: 'WEBHOOK_NOT_FOUND',
            });
        }

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.WEBHOOK_TESTED,
            entity: 'webhook_endpoints',
            entityId: req.params.id,
            req,
            metadata: { delivered: result.delivered },
        });

        return sendSuccess(res, result.delivered ? 'Ping delivered' : 'Ping failed to deliver', result);
    }),

    /** POST /api/integrations/webhooks/:id/retry-failed */
    retryWebhook: asyncHandler(async (req, res) => {
        const requeued = await webhookService.retryFailed(req.params.id);
        return sendSuccess(res, `${requeued} delivery(ies) re-queued`, { requeued });
    }),

    /** GET /api/integrations/deliveries */
    deliveries: asyncHandler(async (req, res) => {
        const query = req.query;

        const deliveries = await webhookService.listDeliveries({
            endpointId: query.endpointId,
            status: query.status,
            limit: query.limit,
        });

        return sendSuccess(res, 'Deliveries retrieved', { deliveries });
    }),
};

export default integrationController;
