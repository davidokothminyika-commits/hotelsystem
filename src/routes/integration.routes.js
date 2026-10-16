/**
 * src/routes/integration.routes.js
 *
 * WHAT THIS MODULE DOES
 * Administration endpoints for the open API: issuing and revoking API keys,
 * registering webhook endpoints, testing them, and reading the delivery log.
 *
 * WHY THIS WHOLE ROUTER IS ADMIN-ONLY
 * Handing out credentials is a system decision: a leaked key reads guest
 * names and emails, and a rogue endpoint receives every booking event. The
 * guard is `requireRole('admin')` on the mount, exactly like /api/admin, so a
 * new route added to this file is protected by the file it lives in.
 *
 * COMMUNICATION
 * Frontend (public/js/pages/admin/integrations.js) -> THIS FILE
 *      -> integration.controller.js -> apiKey.service / webhook.service
 * Database tables used: api_keys, webhook_endpoints, webhook_deliveries.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import {
    apiKeyParamRules,
    createApiKeyRules,
    webhookParamRules,
    createWebhookRules,
    updateWebhookRules,
    deliveryListRules,
} from '../validators/integration.validators.js';
import integrationController from '../controllers/integration.controller.js';

const router = Router();

router.use(requireAuth, requireRole('admin'));

// ------------------------------------------------------------------
// API keys
// ------------------------------------------------------------------

router.get('/api-keys', integrationController.listKeys);

router.post(
    '/api-keys',
    writeLimiter,
    validate(createApiKeyRules),
    integrationController.createKey,
);

router.post(
    '/api-keys/:id/revoke',
    writeLimiter,
    validate(apiKeyParamRules),
    integrationController.revokeKey,
);

// ------------------------------------------------------------------
// Webhooks
// ------------------------------------------------------------------

router.get('/webhooks', integrationController.listWebhooks);

router.get('/webhooks/events', integrationController.listEvents);

router.post(
    '/webhooks',
    writeLimiter,
    validate(createWebhookRules),
    integrationController.createWebhook,
);

router.patch(
    '/webhooks/:id',
    writeLimiter,
    validate(webhookParamRules.concat(updateWebhookRules)),
    integrationController.updateWebhook,
);

router.delete(
    '/webhooks/:id',
    validate(webhookParamRules),
    integrationController.deleteWebhook,
);

router.post(
    '/webhooks/:id/test',
    writeLimiter,
    validate(webhookParamRules),
    integrationController.testWebhook,
);

router.post(
    '/webhooks/:id/retry-failed',
    writeLimiter,
    validate(webhookParamRules),
    integrationController.retryWebhook,
);

// ------------------------------------------------------------------
// Delivery log
// ------------------------------------------------------------------

router.get('/deliveries', validate(deliveryListRules, 'query'), integrationController.deliveries);

export default router;
