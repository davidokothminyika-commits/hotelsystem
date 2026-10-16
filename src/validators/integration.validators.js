/**
 * src/validators/integration.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the integrations admin surface.
 *
 * WHY THE HTTPS RULE IS DEV-ONLY
 * A webhook URL that is plain http would ship a signed payload in cleartext,
 * which matters in production and is exactly what makes local integration
 * testing possible without an HTTPS proxy. The check therefore follows
 * NODE_ENV rather than encouraging a workaround.
 *
 * COMMUNICATION
 * Used by: src/routes/integration.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';
import { WEBHOOK_EVENTS } from '../services/webhook.service.js';
import env from '../config/env.js';

export const apiKeyParamRules = [param('id').isInt({ min: 1 }).withMessage('Invalid key id').toInt()];

export const createApiKeyRules = [
    body('name')
        .notEmpty()
        .withMessage('Name the integration, e.g. "Channel sync"')
        .bail()
        .trim()
        .isLength({ min: 2, max: 80 })
        .withMessage('The name must be between 2 and 80 characters'),
];

export const webhookParamRules = [param('id').isInt({ min: 1 }).withMessage('Invalid endpoint id').toInt()];

export const createWebhookRules = [
    body('url')
        .notEmpty()
        .withMessage('Give the endpoint URL')
        .bail()
        .trim()
        .isLength({ max: 500 })
        .withMessage('URL is too long')
        .matches(/^https?:\/\/.+/i)
        .withMessage('The URL must be an http(s) endpoint')
        .custom((value) => {
            // Cleartext delivery is a development convenience only.
            if (env.isProduction && !value.startsWith('https://')) {
                throw new Error('Webhook endpoints must use https in production');
            }
            return true;
        }),
    body('description')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 160 })
        .withMessage('Description is too long'),
    body('events')
        .isArray({ min: 1 })
        .withMessage('Subscribe to at least one event')
        .custom((events) => events.every((event) => WEBHOOK_EVENTS.includes(event)))
        .withMessage(`Events must be from: ${WEBHOOK_EVENTS.join(', ')}`),
];

export const updateWebhookRules = [
    body('description')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 160 })
        .withMessage('Description is too long'),
    body('events')
        .optional({ values: 'falsy' })
        .isArray({ min: 1 })
        .withMessage('Subscribe to at least one event')
        .custom((events) => events.every((event) => WEBHOOK_EVENTS.includes(event)))
        .withMessage(`Events must be from: ${WEBHOOK_EVENTS.join(', ')}`),
    body('isActive').optional().isBoolean().toBoolean(),
];

export const deliveryListRules = [
    query('endpointId').optional().isInt({ min: 1 }).withMessage('Invalid endpoint').toInt(),
    query('status').optional().isIn(['pending', 'delivered', 'failed']),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
];
