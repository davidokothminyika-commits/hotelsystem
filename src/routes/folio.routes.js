/**
 * src/routes/folio.routes.js
 *
 * WHAT THIS MODULE DOES
 * Endpoints for the guest folio: the front desk board, one folio's ledger,
 * and the charge / credit / void operations on it.
 *
 * PERMISSION MODEL
 *   GET  /api/folios                    -> folio:read   (the board is staff-only)
 *   GET  /api/folios/:bookingId         -> signed in    (a guest may read their
 *                                          own bill; ownership is enforced in
 *                                          the service, exactly like /payments)
 *   POST /api/folios/:bookingId/entries -> folio:write  (posting money to a room
 *                                          account is a front desk decision)
 *   POST .../entries/:entryId/void      -> folio:write
 *
 * COMMUNICATION
 * Frontend (public/js/pages/staff/folios.js) -> THIS FILE
 *      -> folio.controller.js -> folio.service.js
 * Database tables used: folio_entries, bookings, invoices.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requirePermission } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import {
    postEntryRules,
    voidEntryRules,
    listFoliosRules,
    folioParamRules,
    folioEntryParamRules,
} from '../validators/folio.validators.js';
import folioController from '../controllers/folio.controller.js';

const router = Router();

router.use(requireAuth);

// The board. A list endpoint, so no id is involved.
router.get(
    '/',
    requirePermission('folio:read'),
    validate(listFoliosRules, 'query'),
    folioController.list,
);

// One folio. Guests read their own; staff need no extra permission beyond
// being able to see the bookings they work with.
router.get('/:bookingId', validate(folioParamRules), folioController.detail);

router.post(
    '/:bookingId/entries',
    requirePermission('folio:write'),
    writeLimiter,
    validate(folioParamRules.concat(postEntryRules)),
    folioController.postEntry,
);

router.post(
    '/:bookingId/entries/:entryId/void',
    requirePermission('folio:write'),
    writeLimiter,
    validate(folioEntryParamRules.concat(voidEntryRules)),
    folioController.voidEntry,
);

export default router;
