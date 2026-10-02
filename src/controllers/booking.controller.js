/**
 * src/controllers/booking.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for the reservation lifecycle.
 *
 * WHY IT EXISTS
 * Ownership is enforced here by passing `req.user` into the service on every
 * call. The service therefore cannot accidentally act on a booking the
 * caller does not own.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/booking.service.js
 * Frontend: public/js/api/bookings.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import bookingService from '../services/booking.service.js';

const bookingController = {
    /**
     * GET /api/bookings
     * Staff see all bookings; a guest sees only their own.
     */
    list: asyncHandler(async (req, res) => {
        const isStaff = req.user.role !== 'guest';

        const result = await bookingService.listBookings({
            // For a guest the scope is forced to their own id.
            userId: isStaff ? (req.query.userId || undefined) : req.user.id,
            role: req.user.role,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            search: req.query.search,
            sortBy: req.query.sortBy,
            sortDir: req.query.sortDir,
            checkInFrom: req.query.checkInFrom,
            checkInTo: req.query.checkInTo,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Bookings retrieved',
        );
    }),

    /** POST /api/bookings */
    create: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;

        const booking = await bookingService.createBooking({
            userId: req.user.id,
            roomId: payload.roomId,
            checkIn: payload.checkIn,
            checkOut: payload.checkOut,
            guests: payload.guests,
            adults: payload.adults,
            children: payload.children,
            specialRequests: payload.specialRequests,
            guestNames: payload.guestNames,
            // Recorded so the audit trail shows a staff member booked on
            // behalf of the guest rather than the guest self-serving.
            createdBy: req.user.role === 'guest' ? null : req.user.id,
            guestEmail: payload.guestEmail,
            guestName: payload.guestName,
        });

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_CREATED,
            entity: 'bookings',
            entityId: booking.id,
            req,
            metadata: {
                reference: booking.bookingReference,
                room_id: booking.roomId,
                check_in: booking.checkIn,
                check_out: booking.checkOut,
                total: booking.totalAmount,
            },
        });

        return sendCreated(res, 'Booking created successfully', { booking });
    }),

    /** GET /api/bookings/:id */
    detail: asyncHandler(async (req, res) => {
        const booking = await bookingService.getBooking(req.params.id, req.user);
        return sendSuccess(res, 'Booking retrieved', { booking });
    }),

    /** POST /api/bookings/:id/confirm (staff) */
    confirm: asyncHandler(async (req, res) => {
        const booking = await bookingService.confirmBooking(req.params.id, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_UPDATED,
            entity: 'bookings',
            entityId: booking.id,
            req,
            metadata: { status: 'confirmed', reference: booking.bookingReference },
        });

        return sendSuccess(res, 'Booking confirmed successfully', { booking });
    }),

    /** POST /api/bookings/:id/check-in (staff) */
    checkIn: asyncHandler(async (req, res) => {
        const booking = await bookingService.checkIn(req.params.id, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_CHECKED_IN,
            entity: 'bookings',
            entityId: booking.id,
            req,
            metadata: { reference: booking.bookingReference },
        });

        return sendSuccess(res, 'Guest checked in successfully', { booking });
    }),

    /** POST /api/bookings/:id/check-out (staff) */
    checkOut: asyncHandler(async (req, res) => {
        const booking = await bookingService.checkOut(req.params.id, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_CHECKED_OUT,
            entity: 'bookings',
            entityId: booking.id,
            req,
            metadata: { reference: booking.bookingReference },
        });

        return sendSuccess(res, 'Guest checked out successfully', { booking });
    }),

    /** POST /api/bookings/:id/cancel */
    cancel: asyncHandler(async (req, res) => {
        const reason = req.body?.reason;
        const booking = await bookingService.cancelBooking(req.params.id, req.user, reason);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_CANCELLED,
            entity: 'bookings',
            entityId: booking.id,
            req,
            metadata: { reference: booking.bookingReference, reason: reason || null },
        });

        return sendSuccess(res, 'Booking cancelled successfully', { booking });
    }),

    /** GET /api/bookings/:id/availability */
    availability: asyncHandler(async (req, res) => {
        const booking = await bookingService.getBooking(req.params.id, req.user);

        const result = await bookingService.checkAvailability({
            roomId: booking.roomId,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            excludeBookingId: booking.id,
        });

        return sendSuccess(res, 'Availability checked', result);
    }),

    /** GET /api/bookings/summary (guest dashboard cards) */
    summary: asyncHandler(async (req, res) => {
        const [summary, nextBooking] = await Promise.all([
            bookingService.getGuestSummary(req.user.id),
            bookingService.getNextBooking(req.user.id),
        ]);

        return sendSuccess(res, 'Booking summary retrieved', { summary, nextBooking });
    }),

    /** GET /api/bookings/front-desk (reception dashboard) */
    frontDesk: asyncHandler(async (req, res) => {
        const data = await bookingService.getFrontDeskData();
        return sendSuccess(res, 'Front desk data retrieved', data);
    }),

    /** GET /api/bookings/counts (admin dashboard cards) */
    counts: asyncHandler(async (req, res) => {
        const counts = await bookingService.getStatusCounts();
        return sendSuccess(res, 'Booking counts retrieved', { counts });
    }),
};

export default bookingController;