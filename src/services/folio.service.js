/**
 * src/services/folio.service.js
 *
 * WHAT THIS MODULE DOES
 * The guest room folio: extra charges posted by the front desk, credits and
 * discounts, voiding a posted row, and the read view of the bill as it now
 * stands.
 *
 * WHY CHANGES GO THROUGH A LEDGER RATHER THAN EDITING bookings.subtotal
 * An edited number answers "what" but never "who" or "why", and a hotel bill
 * is exactly the artifact a guest will dispute a week later. So every change
 * is an immutable row (a charge or a credit), voiding stamps a row rather than
 * deleting it, and the booking's own money columns are *recomputed* from the
 * room rate plus the live rows. The bill and its history therefore cannot
 * drift apart, and payments - which read bookings.total_amount - follow
 * automatically.
 *
 * WHY THE POST AND THE RECOMPUTE SHARE ONE TRANSACTION
 * A charge that is recorded but leaves the bill unraised is the worst kind of
 * failure: the guest is charged at checkout for something the front desk
 * thought was already in the account. The insert and the recompute commit
 * together or not at all.
 *
 * COMMUNICATION
 * Routes -> folio.controller.js -> THIS FILE
 *        -> folio.repository.js, booking.repository.js
 * Database tables used: folio_entries, bookings, invoices
 */
import ApiError from '../utils/errors.js';
import folioRepository from '../repositories/folio.repository.js';
import bookingRepository from '../repositories/booking.repository.js';
import { withTransaction } from '../config/db.js';

/** Entry types the schema accepts, mirrored here for the validation message. */
export const FOLIO_ENTRY_TYPES = Object.freeze(['charge', 'credit']);

const folioService = {
    /**
     * The full view of one folio: the booking, its ledger and the numbers as
     * they now stand.
     */
    async getFolio(bookingId, requester) {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');

        const isOwner = Number(booking.userId) === Number(requester.id);
        const isStaff = requester.role !== 'guest';
        if (!isOwner && !isStaff) {
            // 404, not 403: the endpoint never confirms that a stranger's
            // booking exists.
            throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
        }

        const entries = await folioRepository.listForBooking(bookingId);
        const extras = entries
            .filter((entry) => !entry.voidedAt)
            .reduce((sum, entry) => sum + entry.signedAmount, 0);

        return {
            booking: {
                id: booking.id,
                bookingReference: booking.bookingReference,
                userId: booking.userId,
                guestName: booking.guestName,
                guestEmail: booking.guestEmail,
                roomNumber: booking.roomNumber,
                roomType: booking.roomType,
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
                status: booking.status,
            },
            // The rate portion of the bill, i.e. what the subtotal was before
            // any folio row moved it.
            roomRate: Number((booking.subtotal - extras).toFixed(2)),
            extrasTotal: Number(extras.toFixed(2)),
            entries,
            totals: {
                subtotal: booking.subtotal,
                taxAmount: booking.taxAmount,
                serviceCharge: booking.serviceCharge,
                totalAmount: booking.totalAmount,
                amountPaid: booking.amountPaid,
                balanceDue: booking.balanceDue,
                currency: 'USD',
            },
        };
    },

    /**
     * Posts one charge or credit and raises the bill accordingly.
     *
     * A charge is a pre-tax line: the recompute applies the hotel's tax and
     * service charge to the adjusted subtotal, exactly as a fresh booking
     * would be priced, so no second tax rate can appear on the bill.
     */
    async postEntry(bookingId, { entryType, description, amount }, requester) {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');

        if (booking.status === 'cancelled') {
            throw ApiError.badRequest('A cancelled booking has no folio', 'BOOKING_CANCELLED');
        }

        if (!FOLIO_ENTRY_TYPES.includes(entryType)) {
            throw ApiError.badRequest('An entry must be a charge or a credit', 'INVALID_ENTRY_TYPE');
        }

        const value = Number(amount);
        // Schema bound: DECIMAL(12,2). A charge that large cannot be legitimate;
        // anything smaller is a real bill line.
        if (!Number.isFinite(value) || value <= 0 || value > 999_999.99) {
            throw ApiError.badRequest('The amount must be greater than zero', 'INVALID_FOLIO_AMOUNT');
        }

        const { entryId, breakdown } = await withTransaction(async (connection) => {
            const id = await folioRepository.insert(
                {
                    bookingId,
                    entryType,
                    description,
                    amount: value.toFixed(2),
                    createdBy: requester.id,
                },
                connection,
            );
            // Raises (or lowers) the bill inside the same transaction.
            const updated = await folioRepository.recomputeBooking(bookingId, connection);
            if (!updated) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
            return { entryId: id, breakdown: updated };
        });

        return { entry: await folioRepository.findById(entryId), breakdown };
    },

    /**
     * Voids one posted entry and lowers the bill back.
     *
     * The row is never deleted: the ledger keeps the history, the void stamps
     * who took it back and why.
     */
    async voidEntry(bookingId, entryId, reason, requester) {
        const entry = await folioRepository.findById(entryId);
        if (!entry || Number(entry.bookingId) !== Number(bookingId)) {
            throw ApiError.notFound('Folio entry not found', 'FOLIO_ENTRY_NOT_FOUND');
        }

        if (entry.voidedAt) {
            throw ApiError.badRequest('This entry is already void', 'FOLIO_ENTRY_ALREADY_VOID');
        }

        const breakdown = await withTransaction(async (connection) => {
            const changed = await folioRepository.voidEntry(
                entryId,
                { voidedBy: requester.id, voidReason: reason },
                connection,
            );
            if (!changed) {
                throw ApiError.badRequest('This entry is already void', 'FOLIO_ENTRY_ALREADY_VOID');
            }
            const updated = await folioRepository.recomputeBooking(bookingId, connection);
            if (!updated) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
            return updated;
        });

        return { entry: await folioRepository.findById(entryId), breakdown };
    },

    /** The folio board: every live reservation with what is still owed. */
    async listFolios({ page, limit, search, status }) {
        return folioRepository.findFoliosWithBalance({ page, limit, search, status });
    },
};

export default folioService;
