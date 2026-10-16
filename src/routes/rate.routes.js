/**
 * src/routes/rate.routes.js
 *
 * WHAT THIS MODULE DOES
 * Endpoints for dynamic pricing: read rules and quotes with `rate:read`,
 * manage rules with `rate:write`.
 *
 * WHY QUOTES AND RULES SHARE A MOUNT
 * A quote is a read-only projection of the rules, so one permission covers
 * both, and the front desk (which holds `rate:read`) can always answer "what
 * would this cost" without being able to change pricing.
 *
 * COMMUNICATION
 * Frontend (public/js/pages/admin/rates.js) -> THIS FILE
 *      -> rate.controller.js -> rate.service.js
 * Database tables used: rate_rules, rooms, bookings.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requirePermission } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { idParamRules } from '../validators/booking.validators.js';
import {
    createRuleRules,
    updateRuleRules,
    listRulesRules,
    quoteRules,
} from '../validators/rate.validators.js';
import rateController from '../controllers/rate.controller.js';

const router = Router();

router.use(requireAuth);

// Literal paths first: '/quote' must not be eaten by '/:id'.
router.get(
    '/quote',
    requirePermission('rate:read'),
    validate(quoteRules, 'query'),
    rateController.quote,
);

router.get(
    '/',
    requirePermission('rate:read'),
    validate(listRulesRules, 'query'),
    rateController.list,
);

router.get(
    '/:id',
    requirePermission('rate:read'),
    validate(idParamRules),
    rateController.detail,
);

router.post(
    '/',
    requirePermission('rate:write'),
    writeLimiter,
    validate(createRuleRules),
    rateController.create,
);

router.patch(
    '/:id',
    requirePermission('rate:write'),
    writeLimiter,
    validate(idParamRules.concat(updateRuleRules)),
    rateController.update,
);

router.delete(
    '/:id',
    requirePermission('rate:write'),
    validate(idParamRules),
    rateController.remove,
);

export default router;
