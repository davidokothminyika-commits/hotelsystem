/**
 * src/routes/rooms.routes.js
 *
 * WHAT THIS MODULE DOES
 * Room browsing for everyone, plus room management for staff.
 *
 * ROUTE ORDER MATTERS
 * Literal paths such as `/availability` and `/types` are declared BEFORE the
 * parameterised `/:id` route. Express matches in order, so `/:id` declared
 * first would treat "availability" as an id and return a confusing 400.
 *
 * COMMUNICATION
 * Frontend (public/js/api/rooms.js) -> THIS FILE -> rooms.controller.js
 * Database tables used: rooms, room_types, amenities, room_amenities, bookings
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireStaff, requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { auditAction } from '../middleware/audit.middleware.js';
import {
    idParamRules,
    availabilityRules,
    roomListRules,
    updateRoomStatusRules,
    createRoomRules,
    updateRoomRules,
} from '../validators/booking.validators.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import roomController from '../controllers/room.controller.js';

const router = Router();

// ---------------------------------------------------------------------------
// Public: guests and staff can both browse
// ---------------------------------------------------------------------------

// Literal routes first, so they are not captured by '/:id'.
router.get('/availability', validate(availabilityRules), roomController.availability);
router.get('/types', roomController.types);
router.get('/amenities', roomController.amenities);
router.get('/status-counts', requireStaff, roomController.statusCounts);

router.get('/', validate(roomListRules), roomController.list);
router.get('/:id', validate(idParamRules), roomController.detail);
router.get('/:id/calendar', validate(idParamRules), roomController.calendar);

// ---------------------------------------------------------------------------
// Staff: operational room management
// ---------------------------------------------------------------------------

router.patch(
    '/:id/status',
    requireStaff,
    validate([...idParamRules, ...updateRoomStatusRules]),
    roomController.updateStatus,
);

// ---------------------------------------------------------------------------
// Administrative: inventory changes
// ---------------------------------------------------------------------------

router.post(
    '/',
    requireRole('admin', 'manager'),
    writeLimiter,
    validate(createRoomRules),
    auditAction(AUDIT_ACTIONS.ROOM_CREATED, () => ({ entity: 'rooms' })),
    roomController.create,
);

router.patch(
    '/:id',
    requireRole('admin', 'manager'),
    validate([...idParamRules, ...updateRoomRules]),
    roomController.update,
);

router.delete(
    '/:id',
    requireRole('admin'),
    validate(idParamRules),
    roomController.remove,
);

export default router;