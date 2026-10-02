/**
 * src/routes/bookings.routes.js
 *
 * WHAT THIS MODULE DOES
 * Reservation endpoints, split into what a guest may do and what staff may do.
 *
 * PERMISSION MODEL
 *   Guests  : create, list own, view own, cancel own
 *   Staff   : list all, view any, confirm, check in, check out, cancel any
 *
 * Ownership is still enforced inside the service, because a URL such as
 * /bookings/42 could always be guessed by a guest. Route-level roles limit
 * which actions are reachable; the service verifies which records.
 *
 * COMMUNICATION
 * Frontend (public/js/api/bookings.js) -> THIS FILE -> bookings.controller.js
 * Database tables used: bookings, booking_guests, rooms, users
 */
import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware.js';
import { requireStaff, requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { auditAction } from '../middleware/audit.middleware.js';
import {
    idParamRules,
    createBookingRules,
    listBookingsRules,
    cancelBookingRules,
} from '../validators/booking.validators.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import bookingController from '../controllers/booking.controller.js';

const router = Router();

// Literal paths before '/:id'.
router.get('/summary', requireAuth, bookingController.summary);
router.get('/front-desk', requireStaff, bookingController.frontDesk);
router.get('/counts', requireStaff, bookingController.counts);

// Everything else requires a session.
router.use(requireAuth);

router.get('/', validate(listBookingsRules), bookingController.list);

router.post(
    '/',
    // Booking creation is rate limited: a guest creating dozens of bookings a
    // minute is a script, not a person.
    writeLimiter,
    validate(createBookingRules),
    auditAction(AUDIT_ACTIONS.BOOKING_CREATED, () => ({ entity: 'bookings' })),
    bookingController.create,
);

router.get('/:id', validate(idParamRules), bookingController.detail);
router.get('/:id/availability', validate(idParamRules), bookingController.availability);

// Confirming, checking in and checking out are reception tasks. requireRole
// lists exactly which staff may perform them, so a restaurant or housekeeping
// account cannot check a guest in.
router.post('/:id/confirm', requireRole('receptionist', 'manager', 'admin'), validate(idParamRules), bookingController.confirm);
router.post('/:id/check-in', requireRole('receptionist', 'manager', 'admin'), validate(idParamRules), bookingController.checkIn);
router.post('/:id/check-out', requireRole('receptionist', 'manager', 'admin'), validate(idParamRules), bookingController.checkOut);

// Cancellation is available to guests for their own bookings and to staff for
// any booking; the service decides which records each may touch.
router.post(
    '/:id/cancel',
    writeLimiter,
    validate([...idParamRules, ...cancelBookingRules]),
    auditAction(AUDIT_ACTIONS.BOOKING_CANCELLED, () => ({ entity: 'bookings' })),
    bookingController.cancel,
);

export { optionalAuth };
export default router;