/**
 * src/routes/external.routes.js
 *
 * WHAT THIS MODULE DOES
 * The open API: a locked-down, read-only surface for third-party systems
 * (channel managers, CRMs, owner dashboards) authenticated with an API key.
 *
 * WHAT IT HOLDS BACK
 * It can inspect inventory, reservations, folio balances and occupancy - and
 * that is all. No write endpoints exist here and none are planned: the one
 * thing a shared credential must never be able to do is modify the ledger.
 * Writes go through staff accounts, which have named audit trails.
 *
 * WHY THE GUEST FIELD IS INCLUDED IN LIST OUTPUT
 * A CRM syncing contacts needs names and emails. Keys are issued per
 * integration from the admin panel and are verified per request, so revoking
 * one cuts its access instantly - the trust boundary is the credential, not
 * the endpoint.
 *
 * COMMUNICATION
 * Guards: middleware/apiKeyAuth.middleware.js
 * Reuses: room.service.js, booking.repository.js (read paths only, so this
 *         surface cannot invent behaviour the staff API does not have)
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.middleware.js';
import { requireApiKey } from '../middleware/apiKeyAuth.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { sendSuccess, sendPaginated } from '../utils/response.js';
import { availabilityRules, listBookingsRules } from '../validators/booking.validators.js';
import roomService from '../services/room.service.js';
import roomRepository from '../repositories/room.repository.js';
import bookingRepository, { OCCUPYING_STATUSES } from '../repositories/booking.repository.js';
import folioRepository from '../repositories/folio.repository.js';
import { WEBHOOK_EVENTS } from '../services/webhook.service.js';
import { parseDate, formatDate, today, nightsBetween } from '../utils/date.js';

const router = Router();

// Every route below is read-only and therefore guarded with the same single
// line - a new endpoint added to this file cannot accidentally be public.
router.use(requireApiKey);

router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'External API ready',
        data: {
            status: 'healthy',
            key: req.apiKey.name,
            keyPrefix: req.apiKey.keyPrefix,
            timestamp: new Date().toISOString(),
        },
    });
});

/**
 * GET /api/external/rooms/availability
 * Room search that mirrors the booking engine's own view: what is sellable,
 * for how much, per stays and rules in force.
 */
router.get(
    '/rooms/availability',
    validate(availabilityRules, 'query'),
    asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await roomService.searchAvailability({
            checkIn: query.checkIn,
            checkOut: query.checkOut,
            guests: query.guests,
            roomTypeId: query.roomType,
            minPrice: query.minPrice,
            maxPrice: query.maxPrice,
            page: query.page,
            limit: query.limit ?? 20,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        // Room-level rows only: the external contract is stable and does not
        // include the joined guest text the internal search returns.
        return sendPaginated(res, result.rooms, {
            page: result.page,
            limit: result.limit,
            total: result.total,
        }, 'Availability retrieved');
    }),
);

/**
 * GET /api/external/bookings
 * Reservation list for syncing a channel manager or CRM. Same filters as the
 * internal list, plus a key-scoped wrapper, so filters behave identically.
 */
router.get(
    '/bookings',
    validate(listBookingsRules, 'query'),
    asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await bookingRepository.findMany({
            page: query.page,
            limit: query.limit ?? 20,
            userId: query.userId,
            status: query.status,
            roomId: query.roomId,
            search: query.search,
            checkInFrom: query.checkInFrom,
            checkInTo: query.checkInTo,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        // The response carries what a sync consumer needs: reference, dates,
        // status, money and guest identity. Internal-only fields (audit actor,
        // internal ids) are still present but not relied on.
        return sendPaginated(res, result.rows, {
            page: result.page ?? 1,
            limit: result.limit ?? 20,
            total: result.total,
        }, 'Bookings retrieved');
    }),
);

/**
 * GET /api/external/bookings/:reference
 * One reservation by its public reference - the form third parties use,
 * because the internal numeric id is meaningless outside this system.
 */
router.get(
    '/bookings/:reference',
    asyncHandler(async (req, res) => {
        const booking = await bookingRepository.findByReference(req.params.reference);
        if (!booking) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found',
                code: 'BOOKING_NOT_FOUND',
            });
        }
        return sendSuccess(res, 'Booking retrieved', { booking });
    }),
);

/**
 * GET /api/external/folios/:bookingReference
 * The live bill for a booking, which is what a channel reconciler needs to
 * know what a stay actually cost, inclusive of folio charges.
 */
router.get(
    '/folios/:bookingReference',
    asyncHandler(async (req, res) => {
        const booking = await bookingRepository.findByReference(req.params.bookingReference);
        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found', code: 'BOOKING_NOT_FOUND' });
        }

        const entries = await folioRepository.listForBooking(booking.id);

        return sendSuccess(res, 'Folio retrieved', {
            bookingReference: booking.bookingReference,
            totals: {
                subtotal: booking.subtotal,
                taxAmount: booking.taxAmount,
                serviceCharge: booking.serviceCharge,
                totalAmount: booking.totalAmount,
                amountPaid: booking.amountPaid,
                balanceDue: booking.balanceDue,
            },
            entries,
        });
    }),
);

/**
 * GET /api/external/occupancy?from=&to=
 * Occupancy as a percentage of sellable room-nights over the window, which is
 * what owner dashboards and channel demand models read.
 */
router.get(
    '/occupancy',
    asyncHandler(async (req, res) => {
        const from = typeof req.query.from === 'string' ? req.query.from : undefined;
        const to = typeof req.query.to === 'string' ? req.query.to : undefined;

        const start = parseDate(from) || today();
        const end = parseDate(to) || new Date(start.getTime() + 7 * 86_400_000);

        const counts = await roomRepository.getStatusCounts();
        const sellable =
            Number(counts.available ?? 0) + Number(counts.occupied ?? 0) + Number(counts.reserved ?? 0);

        const booked = await bookingRepository.countOccupiedRoomNights(
            formatDate(start),
            formatDate(end),
            OCCUPYING_STATUSES,
        );

        const capacityNights = sellable * nightsBetween(start, end);

        return sendSuccess(res, 'Occupancy retrieved', {
            from: formatDate(start),
            to: formatDate(end),
            sellableRooms: sellable,
            capacityRoomNights: capacityNights,
            occupiedRoomNights: booked,
            occupancyPercent: capacityNights > 0 ? Number(((booked / capacityNights) * 100).toFixed(2)) : 0,
        });
    }),
);

/**
 * GET /api/external/webhook-events
 * The event catalogue, so an integration can verify its subscriptions against
 * what this system ever plans to send without asking a person.
 */
router.get('/webhook-events', (_req, res) => {
    res.json({
        success: true,
        message: 'Webhook events retrieved',
        data: { events: WEBHOOK_EVENTS },
    });
});

export default router;
