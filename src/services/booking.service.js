/**
 * src/services/booking.service.js
 *
 * WHAT THIS MODULE DOES
 * Booking business rules: pricing, availability validation, the reservation
 * lifecycle (pending -> confirmed -> checked_in -> checked_out) and
 * cancellation.
 *
 * WHY IT EXISTS
 * The booking lifecycle has real rules about who may act and when. Keeping
 * them in one place means a receptionist, a guest and the automated tests all
 * get identical behaviour, and a rule change is a single edit.
 *
 * COMMUNICATION
 * Browser -> /api/bookings/* -> bookings.controller.js -> THIS FILE
 *        -> booking.repository.js, room.repository.js,
 *           notification.service.js, mail.service.js
 * Database tables used: bookings, booking_guests, rooms, users, invoices
 *
 * REQUEST FLOW FOR A NEW BOOKING
 *   Browser
 *      -> POST /api/bookings
 *      -> requireAuth (who is the guest?)
 *      -> validate (is the input well formed?)
 *      -> bookings.controller.js
 *      -> bookingService.createBooking
 *           -> parse and validate dates
 *           -> load the room and check capacity
 *           -> check availability (layer 1)
 *           -> withTransaction
 *                -> lock the room row and re-check (layers 2 and 3)
 *                -> insert the booking
 *                -> insert the invoice
 *                -> insert notifications
 *           -> send confirmation email
 *      -> 201 with the booking
 */
import ApiError from '../utils/errors.js';
import { withTransaction } from '../config/db.js';
import { parseDate, formatDate, nightsBetween, today } from '../utils/date.js';
import bookingRepository from '../repositories/booking.repository.js';
import roomRepository from '../repositories/room.repository.js';
import notificationService from './notification.service.js';
import mailService from './mail.service.js';
import { PRICING, calculateTotals } from '../config/pricing.js';

/**
 * Pricing rules live in src/config/pricing.js so bookings, orders, invoices,
 * notifications and reports all read the same rates. Re-exported here for
 * convenience so callers working with bookings can import them from one place.
 */
export { PRICING, calculateTotals };

/**
 * Validates the requested date window and returns normalised dates.
 * Every date rule lives here so no caller can skip a check.
 */
function validateStay(checkInValue, checkOutValue) {
    const checkIn = parseDate(checkInValue);
    const checkOut = parseDate(checkOutValue);

    if (!checkIn || !checkOut) {
        throw ApiError.badRequest('Check-in and check-out must be valid dates in YYYY-MM-DD format', 'INVALID_DATE');
    }

    if (checkOut <= checkIn) {
        throw ApiError.badRequest('Check-out date must be after the check-in date', 'INVALID_DATE_RANGE');
    }

    const nights = nightsBetween(checkIn, checkOut);

    if (nights > PRICING.maximumNights) {
        throw ApiError.badRequest(
            `A single booking may not exceed ${PRICING.maximumNights} nights`,
            'STAY_TOO_LONG',
        );
    }

    if (checkIn < today()) {
        throw ApiError.badRequest('Check-in date cannot be in the past', 'DATE_IN_PAST');
    }

    if (checkIn < addDays(today(), PRICING.minimumLeadDays)) {
        throw ApiError.badRequest(
            `Bookings require at least ${PRICING.minimumLeadDays} days notice`,
            'INSUFFICIENT_LEAD_TIME',
        );
    }

    return { checkIn, checkOut, nights };
}

/** Local helper to avoid importing addDays twice. */
function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

/**
 * Calculates the money breakdown for a stay.
 * Delegates to the shared pricing helper so booking totals and order totals
 * can never drift apart.
 */
export function calculateStayTotals(pricePerNight, nights) {
    return calculateTotals(Number(pricePerNight) * nights);
}

const bookingService = {
    /**
     * Creates a reservation.
     *
     * @param {object} input
     * @param {number} input.userId Guest making the booking.
     * @param {number} input.roomId
     * @param {string} input.checkIn  YYYY-MM-DD
     * @param {string} input.checkOut YYYY-MM-DD
     * @param {number} input.guests
     * @param {string} [input.specialRequests]
     * @param {number} [input.createdBy] Staff member booking on a guest's behalf.
     * @param {string[]} [input.guestNames] Additional guests on the reservation.
     */
    async createBooking(input) {
        const { checkIn, checkOut, nights } = validateStay(input.checkIn, input.checkOut);

        const room = await roomRepository.findById(input.roomId);
        if (!room) {
            throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
        }
        if (!room.isActive) {
            throw ApiError.badRequest('This room is no longer available for booking', 'ROOM_RETIRED');
        }
        if (['maintenance', 'cleaning'].includes(room.status)) {
            throw ApiError.badRequest(
                `This room is currently ${room.status} and cannot be booked`,
                'ROOM_UNAVAILABLE',
            );
        }
        if (input.guests > room.capacity) {
            throw ApiError.badRequest(
                `This room sleeps up to ${room.capacity} guests`,
                'CAPACITY_EXCEEDED',
            );
        }

        // Layer 1: a fast pre-check so the guest gets a clear message before
        // a transaction is opened.
        const available = await roomRepository.isRoomAvailable(room.id, checkIn, checkOut);
        if (!available) {
            throw ApiError.conflict(
                'This room has just been booked for those dates. Please choose another room or date.',
                'ROOM_UNAVAILABLE',
            );
        }

        const totals = calculateStayTotals(room.pricePerNight, nights);
        const reference = await bookingRepository.generateReference();

        // Layers 2 and 3 live inside the transaction, in the repository.
        const result = await withTransaction(async (connection) => {
            const created = await bookingRepository.createBooking(connection, {
                bookingReference: reference,
                userId: input.userId,
                roomId: room.id,
                checkIn: formatDate(checkIn),
                checkOut: formatDate(checkOut),
                guests: input.guests || 1,
                adults: input.adults ?? input.guests ?? 1,
                children: input.children ?? 0,
                status: 'pending',
                pricePerNight: room.pricePerNight,
                nights,
                subtotal: totals.subtotal,
                taxAmount: totals.taxAmount,
                serviceCharge: totals.serviceCharge,
                totalAmount: totals.totalAmount,
                specialRequests: input.specialRequests || null,
                createdBy: input.createdBy || null,
            });

            if (created.conflict) {
                throw ApiError.conflict(
                    'This room has just been booked for those dates. Please choose another room or date.',
                    'ROOM_UNAVAILABLE',
                );
            }

            // Additional named guests travel with the reservation.
            if (Array.isArray(input.guestNames)) {
                for (const guest of input.guestNames.slice(0, 8)) {
                    if (!guest?.firstName) continue;
                    await bookingRepository.addGuest(created.insertId, {
                        firstName: String(guest.firstName).slice(0, 80),
                        lastName: guest.lastName ? String(guest.lastName).slice(0, 80) : null,
                        isPrimary: false,
                    });
                }
            }

            return created.insertId;
        });

        const booking = await bookingRepository.findById(result);

        // Notifications and email happen after the transaction commits, so a
        // mail failure cannot roll back a confirmed reservation.
        await notificationService.notifyBookingCreated(booking).catch((error) =>
            console.error('[booking] Notification failed:', error.message),
        );

        mailService.sendBookingConfirmation({
            to: input.guestEmail,
            name: input.guestName || 'Guest',
            booking: {
                id: booking.id,
                bookingReference: booking.bookingReference,
                roomNumber: booking.roomNumber,
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
                totalAmount: booking.totalAmount,
                currency: PRICING.currency,
            },
        }).catch((error) => console.error('[booking] Confirmation email failed:', error.message));

        return booking;
    },

    /** Lists bookings, scoped to the requesting user when they are a guest. */
    async listBookings({ userId, role, page, limit, status, search, sortBy, sortDir, checkInFrom, checkInTo }) {
        // A guest may only ever list their own bookings. Staff list all, which
        // is what the reception and admin dashboards rely on.
        const scopeUserId = role === 'guest' ? userId : undefined;
        return bookingRepository.findMany({
            page,
            limit,
            userId: scopeUserId,
            status,
            search,
            sortBy,
            sortDir,
            checkInFrom,
            checkInTo,
        });
    },

    /**
     * Returns one booking, enforcing ownership.
     * A guest asking for someone else's booking gets 404 rather than 403, so
     * the endpoint does not confirm that the booking exists.
     */
    async getBooking(id, requester) {
        const booking = await bookingRepository.findById(id);
        if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');

        const isOwner = Number(booking.userId) === Number(requester.id);
        const isStaff = requester.role !== 'guest';

        if (!isOwner && !isStaff) {
            throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
        }

        return booking;
    },

    /**
     * Confirms a pending booking.
     * Only reception or management may confirm; a guest cannot confirm their
     * own reservation because confirmation triggers obligations.
     */
    async confirmBooking(id, requester) {
        const booking = await this.getBooking(id, requester);

        if (booking.status !== 'pending') {
            throw ApiError.badRequest(
                `A booking with status "${booking.status}" cannot be confirmed`,
                'INVALID_STATUS_TRANSITION',
            );
        }

        // Confirming only makes sense if the room is still free. This booking
        // is excluded from the check, because it occupies those dates itself
        // and would otherwise conflict with itself.
        const available = await roomRepository.isRoomAvailable(
            booking.roomId,
            booking.checkIn,
            booking.checkOut,
            { excludeBookingId: booking.id },
        );
        if (!available) {
            throw ApiError.conflict(
                'The room is no longer available for these dates and the booking cannot be confirmed',
                'ROOM_UNAVAILABLE',
            );
        }

        const updated = await bookingRepository.updateStatus(id, 'confirmed');

        await notificationService.notifyBookingConfirmed(updated).catch((error) =>
            console.error('[booking] Notification failed:', error.message),
        );

        return updated;
    },

    /**
     * Checks a guest in.
     * Sets the room to occupied so it leaves the availability pool.
     */
    async checkIn(id, requester) {
        const booking = await this.getBooking(id, requester);

        if (booking.status !== 'confirmed') {
            throw ApiError.badRequest(
                `Only a confirmed booking can be checked in (this one is "${booking.status}")`,
                'INVALID_STATUS_TRANSITION',
            );
        }

        if (new Date(booking.checkOut) < today()) {
            throw ApiError.badRequest('This booking has already ended', 'STAY_ALREADY_ENDED');
        }

        const updated = await bookingRepository.updateStatus(id, 'checked_in', { checkedInAt: new Date() });
        await roomRepository.updateStatus(booking.roomId, 'occupied');

        await notificationService.notifyCheckedIn(updated).catch((error) =>
            console.error('[booking] Notification failed:', error.message),
        );

        return updated;
    },

    /**
     * Checks a guest out and marks the room for cleaning.
     *
     * The room is set to `cleaning` rather than `available` because
     * housekeeping must inspect it before it can be sold again. Skipping this
     * step is the usual cause of a room being sold dirty.
     */
    async checkOut(id, requester) {
        const booking = await this.getBooking(id, requester);

        if (booking.status !== 'checked_in') {
            throw ApiError.badRequest(
                `Only a checked-in booking can be checked out (this one is "${booking.status}")`,
                'INVALID_STATUS_TRANSITION',
            );
        }

        const updated = await bookingRepository.updateStatus(id, 'checked_out', { checkedOutAt: new Date() });
        await roomRepository.updateStatus(booking.roomId, 'cleaning');

        await notificationService.notifyCheckedOut(updated).catch((error) =>
            console.error('[booking] Notification failed:', error.message),
        );

        return updated;
    },

    /**
     * Cancels a booking.
     *
     * Rules:
     *   - a guest may only cancel their own booking,
     *   - a booking that has already been checked in cannot be cancelled
     *     (the stay happened and must be settled through checkout),
     *   - cancellation frees the room again, because the availability query
     *     ignores cancelled bookings.
     */
    async cancelBooking(id, requester, reason) {
        const booking = await this.getBooking(id, requester);

        if (booking.status === 'cancelled') {
            throw ApiError.badRequest('This booking is already cancelled', 'ALREADY_CANCELLED');
        }

        if (booking.status === 'checked_out') {
            throw ApiError.badRequest('A completed stay cannot be cancelled', 'CANNOT_CANCEL_COMPLETED');
        }

        if (booking.status === 'checked_in') {
            throw ApiError.badRequest(
                'This guest is currently checked in. Please complete checkout instead of cancelling.',
                'CANNOT_CANCEL_CHECKED_IN',
            );
        }

        const updated = await bookingRepository.updateStatus(id, 'cancelled', {
            cancelledAt: new Date(),
            cancellationReason: reason || null,
        });

        // Release the room, but only if no other booking now covers these
        // dates. `isRoomAvailable` ignores cancelled bookings, so it returns
        // true once this booking no longer occupies the room.
        const freeAgain = await roomRepository.isRoomAvailable(
            booking.roomId,
            booking.checkIn,
            booking.checkOut,
        );
        if (freeAgain) {
            const room = await roomRepository.findById(booking.roomId);
            // Never move a room that housekeeping or maintenance owns, and
            // never mark an occupied room available when another guest is in it.
            if (room && !['maintenance', 'cleaning', 'occupied'].includes(room.status)) {
                await roomRepository.updateStatus(booking.roomId, 'available');
            }
        }

        await notificationService.notifyBookingCancelled(updated, reason).catch((error) =>
            console.error('[booking] Notification failed:', error.message),
        );

        return updated;
    },

    /** Headline numbers for the guest dashboard. */
    async getGuestSummary(userId) {
        return bookingRepository.getGuestSummary(userId);
    },

    async getNextBooking(userId) {
        return bookingRepository.getNextBooking(userId);
    },

    /** Today's arrivals and departures for the reception desk. */
    async getFrontDeskData() {
        const [arrivals, departures, inHouse] = await Promise.all([
            bookingRepository.getTodayArrivals(),
            bookingRepository.getTodayDepartures(),
            bookingRepository.getInHouse(),
        ]);

        return { arrivals, departures, inHouse };
    },

    async getStatusCounts() {
        return bookingRepository.getStatusCounts();
    },

    /**
     * Checks availability without creating anything, used by the booking form
     * to show a live "still available" indicator.
     */
    async checkAvailability({ roomId, checkIn, checkOut, excludeBookingId }) {
        const { checkIn: start, checkOut: end } = validateStay(checkIn, checkOut);

        if (!excludeBookingId) {
            const available = await roomRepository.isRoomAvailable(roomId, start, end);
            return { available, conflict: false };
        }

        // Editing an existing booking must ignore the booking being edited.
        const available = await roomRepository.isRoomAvailable(roomId, start, end, {
            excludeBookingId,
        });

        return { available, conflict: !available };
    },
};

export default bookingService;