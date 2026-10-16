/**
 * src/routes/maintenance.routes.js
 *
 * WHAT THIS MODULE DOES
 * Endpoints for repair work orders: list, counts, detail, raise and update.
 *
 * PERMISSION MODEL
 *   Reads and counts  -> maintenance:read   (housekeeping sees its queue; the
 *                              front desk sees why a room cannot be sold)
 *   Writes            -> maintenance:write  (raising and resolving work is a
 *                              department decision, not a display action)
 * No guest path exists: a guest reporting a fault goes through the existing
 * messaging system, and staff turn that into a ticket.
 *
 * COMMUNICATION
 * Frontend (public/js/pages/staff/maintenance.js) -> THIS FILE
 *      -> maintenance.controller.js -> maintenance.service.js
 * Database tables used: maintenance_tickets, rooms.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requirePermission } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { idParamRules } from '../validators/booking.validators.js';
import {
    createTicketRules,
    updateTicketRules,
    listTicketRules,
} from '../validators/maintenance.validators.js';
import maintenanceController from '../controllers/maintenance.controller.js';

const router = Router();

// Declared before the first route so every guard below sees req.user.
router.use(requireAuth);

// Literal paths first, so '/counts' can never be eaten by '/:id'.
router.get(
    '/',
    requirePermission('maintenance:read'),
    validate(listTicketRules, 'query'),
    maintenanceController.list,
);

router.get(
    '/counts',
    requirePermission('maintenance:read'),
    maintenanceController.counts,
);

router.get(
    '/:id',
    requirePermission('maintenance:read'),
    validate(idParamRules),
    maintenanceController.detail,
);

router.post(
    '/',
    requirePermission('maintenance:write'),
    writeLimiter,
    validate(createTicketRules),
    maintenanceController.create,
);

router.patch(
    '/:id',
    requirePermission('maintenance:write'),
    writeLimiter,
    validate(idParamRules.concat(updateTicketRules)),
    maintenanceController.update,
);

export default router;
