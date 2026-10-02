/**
 * src/repositories/booking.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for reservations, including the transactional create that prevents
 * double booking.
 *
 * WHY THIS EXISTS
 * Booking is the operation where correctness matters most: a double booking
 * means two guests arrive expecting the same room. The prevention strategy is
 * documented in `createBooking` and is the reason booking creation runs in a
 * transaction with a row lock.
 *
 * COMMUNICATION
 * Called by: services/booking.service.js
 * Database tables used: bookings, booking_guests, users, rooms
 * Frontend access: /api/bookings, /api/bookings/:id
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolvePagination, resolveSort } from './base.repository.js';

const SORTABLE_BOOKING_COLUMNS = ['b.created_at', 'b.check_in', 'b.check_out', 'b.total_amount', 'b.status'];

/** Statuses that occupy a room. A cancelled booking frees it again. */
export const OCCUPYING_STATUSES = ['pending', 'confirmed', 'checked_in'];

function mapBooking(row) {
    if (!row) return null;
    return {
        id: row.id,
        bookingReference: row.booking_reference,
        userId: row.user_id,
        roomId: row.room_id,
        checkIn: row.check_in,
        checkOut: row.check_out,
        guests: row.guests,
        adults: row.adults,
        children: row.children,
        status: row.status,
        pricePerNight: Number(row.price_per_night),
        nights: row.nights,
        subtotal: Number(row.subtotal),
        taxAmount: Number(row.tax_amount),
        serviceCharge: Number(row.service_charge),
        totalAmount: Number(row.total_amount),
        amountPaid: Number(row.amount_paid),
        balanceDue: Number(row.total_amount) - Number(row.amount_paid),
        specialRequests: row.special_requests,
        checkedInAt: row.checked_in_at,
        checkedOutAt: row.checked_out_at,
        cancelledAt: row.cancelled_at,
        cancellationReason: row.cancellation_reason,
        createdAt: row.created_at,
        // Joined display fields.
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        roomNumber: row.room_number,
        roomType: row.room_type,
        roomImage: row.room_image,
    };
}

const bookingRepository = {
    /**
     * Creates a booking inside a transaction with a row-level lock.
     *
     * HOW DOUBLE BOOKING IS PREVENTED (three layers)
     *
     *   Layer 1 - Pre-check: an availability query runs first to give the
     *   guest a fast, clear error.
     *
     *   Layer 2 - Row lock (the real guarantee): `SELECT ... FOR UPDATE` on the
     *   room row serialises concurrent booking attempts for the same room. The
     *   second transaction blocks until the first commits, then re-reads and
     *   sees the newly inserted booking, so it is rejected. Without this, two
     *   simultaneous requests could both pass their check and both insert.
     *
     *   Layer 3 - Re-check inside the lock: the overlap query runs again after
     *   the lock is acquired, because the pre-check result may be stale by the
     *   time the lock is granted.
     *
     * This is why booking creation accepts a connection: it must join the
     * caller's transaction to hold the lock until commit.
     *
     * @param {import('mysql2/promise').PoolConnection} connection
     */
    async createBooking(connection, data) {
        // Layer 2: lock the room row. Two requests for the same room queue here.
        await connection.execute('SELECT id FROM rooms WHERE id = :roomId FOR UPDATE', {
            roomId: data.roomId,
        });

        // Layer 3: authoritative overlap check while holding the lock.
        const [conflicts] = await connection.execute(
            `SELECT id, booking_reference FROM bookings
             WHERE room_id = :roomId
               AND status IN ('pending', 'confirmed', 'checked_in')
               AND check_in < :checkOut
               AND check_out > :checkIn
             LIMIT 1
             FOR UPDATE`,
            { roomId: data.roomId, checkIn: data.checkIn, checkOut: data.checkOut },
        );

        if (conflicts.length > 0) {
            return { conflict: true, conflictingReference: conflicts[0].booking_reference };
        }

        const [result] = await connection.execute(
            `INSERT INTO bookings
               (booking_reference, user_id, room_id, check_in, check_out, guests, adults, children,
                status, price_per_night, nights, subtotal, tax_amount, service_charge, total_amount,
                special_requests, created_by)
             VALUES
               (:bookingReference, :userId, :roomId, :checkIn, :checkOut, :guests, :adults, :children,
                :status, :pricePerNight, :nights, :subtotal, :taxAmount, :serviceCharge, :totalAmount,
                :specialRequests, :createdBy)`,
            data,
        );

        return { conflict: false, insertId: result.insertId };
    },

    async findById(id) {
        const row = await queryOne(
            `SELECT b.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number, rt.name AS room_type, r.image AS room_image
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.id = :id`,
            { id },
        );
        return mapBooking(row);
    },

    async findByReference(reference) {
        const row = await queryOne('SELECT id FROM bookings WHERE booking_reference = :reference', { reference });
        return row ? this.findById(row.id) : null;
    },

    /**
     * Paginated booking list. `scope` restricts results for non-admin roles.
     * Guests only ever see their own bookings.
     */
    async findMany({ page = 1, limit = 20, userId, status, roomId, checkInFrom, checkInTo, search, sortBy, sortDir }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = { limit: pagination.limit, offset: pagination.offset };

        if (userId) {
            conditions.push({ sql: 'b.user_id = :userId', params: { userId } });
        }
        if (status) {
            // Support a comma separated list, useful for status filter chips.
            const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, index) => `:status${index}`).join(', ');
                conditions.push({
                    sql: `b.status IN (${placeholders})`,
                    params: Object.fromEntries(statuses.map((value, index) => [`status${index}`, value])),
                });
            }
        }
        if (roomId) {
            conditions.push({ sql: 'b.room_id = :roomId', params: { roomId } });
        }
        if (checkInFrom) {
            conditions.push({ sql: 'b.check_in >= :checkInFrom', params: { checkInFrom } });
        }
        if (checkInTo) {
            conditions.push({ sql: 'b.check_in <= :checkInTo', params: { checkInTo } });
        }
        if (search) {
            conditions.push({
                sql: '(b.booking_reference LIKE :search OR u.first_name LIKE :search OR u.last_name LIKE :search OR u.email LIKE :search OR r.room_number LIKE :search)',
                params: { search: `%${search}%` },
            });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        // Newest first by default: a guest looking for the stay they just made should
        // not have to scroll past their history.
        const sort = resolveSort(sortBy, sortDir, SORTABLE_BOOKING_COLUMNS, 'b.created_at', 'DESC');

        const rows = await query(
            `SELECT b.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number, rt.name AS room_type, r.image AS room_image
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             ${where}
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             ${where}`,
            filterParams,
        );

        return { rows: rows.map(mapBooking), total: countRow ? Number(countRow.total) : 0 };
    },

    async updateStatus(id, status, extra = {}) {
        await execute(
            `UPDATE bookings SET
                status = :status,
                checked_in_at = COALESCE(:checkedInAt, checked_in_at),
                checked_out_at = COALESCE(:checkedOutAt, checked_out_at),
                cancelled_at = COALESCE(:cancelledAt, cancelled_at),
                cancellation_reason = COALESCE(:cancellationReason, cancellation_reason)
             WHERE id = :id`,
            {
                id,
                status,
                checkedInAt: extra.checkedInAt ?? null,
                checkedOutAt: extra.checkedOutAt ?? null,
                cancelledAt: extra.cancelledAt ?? null,
                cancellationReason: extra.cancellationReason ?? null,
            },
        );
        return this.findById(id);
    },

    /**
     * Updates the paid amount. Called by the payment service inside the same
     * transaction that inserts the payment, so the balance is never wrong.
     */
    async addPaymentAmount(id, amount, connection = null) {
        const sql = 'UPDATE bookings SET amount_paid = amount_paid + :amount WHERE id = :id';
        if (connection) {
            await connection.execute(sql, { id, amount });
        } else {
            await execute(sql, { id, amount });
        }
    },

    async addGuest(bookingId, { firstName, lastName, isPrimary }) {
        await execute(
            `INSERT INTO booking_guests (booking_id, first_name, last_name, is_primary)
             VALUES (:bookingId, :firstName, :lastName, :isPrimary)`,
            { bookingId, firstName, lastName: lastName || null, isPrimary: isPrimary ? 1 : 0 },
        );
    },

    async listGuests(bookingId) {
        return query(
            'SELECT id, first_name, last_name, is_primary FROM booking_guests WHERE booking_id = :bookingId',
            { bookingId },
        );
    },

    /**
     * Generates a unique, human readable booking reference.
     *
     * Format: BK + 10 uppercase alphanumeric characters, which fits the
     * CHAR(12) column exactly.
     *
     * The middle 6 characters are a base36 timestamp, so references sort
     * roughly by creation time and a support agent can tell roughly when a
     * booking was made. The remaining 4 are random to make collisions unlikely.
     * The uniqueness check below turns "unlikely" into "guaranteed".
     *
     * 36^10 is roughly 3.6 quadrillion possibilities, so the retry loop will
     * effectively never run twice.
     */
    async generateReference() {
        // Characters exclude look-alikes (0/O, 1/I/L) so a reference read aloud
        // at reception is unambiguous.
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const timestamp = Date.now().toString(36).toUpperCase().padStart(6, '0').slice(-6);
            let random = '';
            for (let i = 0; i < 4; i += 1) {
                random += alphabet[Math.floor(Math.random() * alphabet.length)];
            }

            const reference = `BK${timestamp}${random}`;

            const existing = await queryOne('SELECT id FROM bookings WHERE booking_reference = :reference', {
                reference,
            });
            if (!existing) return reference;
        }

        // Falling through is effectively unreachable, but a unique index on
        // booking_reference is the final guarantee at the database level.
        throw new Error('Unable to generate a unique booking reference');
    },

    // -------------------------------------------------------------------------
    // Aggregates for dashboards and reports
    // -------------------------------------------------------------------------

    /** Guest dashboard headline numbers. */
    async getGuestSummary(userId) {
        const totals = await queryOne(
            `SELECT
                COUNT(*) AS total_bookings,
                SUM(CASE WHEN status IN ('pending','confirmed') AND check_in >= CURDATE() THEN 1 ELSE 0 END) AS upcoming,
                SUM(CASE WHEN status = 'checked_in' THEN 1 ELSE 0 END) AS in_house,
                SUM(CASE WHEN status = 'checked_out' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
                COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') THEN total_amount ELSE 0 END), 0) AS total_spent,
                COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') THEN total_amount - amount_paid ELSE 0 END), 0) AS outstanding
             FROM bookings WHERE user_id = :userId`,
            { userId },
        );

        return {
            totalBookings: Number(totals?.total_bookings || 0),
            upcoming: Number(totals?.upcoming || 0),
            inHouse: Number(totals?.in_house || 0),
            completed: Number(totals?.completed || 0),
            cancelled: Number(totals?.cancelled || 0),
            totalSpent: Number(totals?.total_spent || 0),
            outstandingBalance: Number(totals?.outstanding || 0),
        };
    },

    /** The next upcoming booking, used on the guest dashboard. */
    async getNextBooking(userId) {
        const row = await queryOne(
            `SELECT b.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    r.room_number, rt.name AS room_type, r.image AS room_image
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.user_id = :userId
               AND b.status IN ('pending', 'confirmed')
               AND b.check_out >= CURDATE()
             ORDER BY b.check_in ASC
             LIMIT 1`,
            { userId },
        );
        return mapBooking(row);
    },

    /** Hotel-wide booking counts for the admin dashboard. */
    async getStatusCounts() {
        const rows = await query('SELECT status, COUNT(*) AS total FROM bookings GROUP BY status');
        const counts = { pending: 0, confirmed: 0, checked_in: 0, checked_out: 0, cancelled: 0 };
        for (const row of rows) counts[row.status] = Number(row.total);
        counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
        return counts;
    },

    /**
     * Bookings arriving or departing today, for the reception dashboard.
     */
    async getTodayArrivals() {
        const rows = await query(
            `SELECT b.*, CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email, u.phone, r.room_number, rt.name AS room_type
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.check_in = CURDATE() AND b.status IN ('pending', 'confirmed')
             ORDER BY b.created_at ASC`,
        );
        return rows.map(mapBooking);
    },

    async getTodayDepartures() {
        const rows = await query(
            `SELECT b.*, CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email, r.room_number, rt.name AS room_type
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.check_out = CURDATE() AND b.status = 'checked_in'
             ORDER BY b.check_out ASC`,
        );
        return rows.map(mapBooking);
    },

    /** Currently in-house guests, for reception and housekeeping. */
    async getInHouse() {
        const rows = await query(
            `SELECT b.*, CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email, u.phone, r.room_number, rt.name AS room_type
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.status = 'checked_in'
             ORDER BY b.check_out ASC`,
        );
        return rows.map(mapBooking);
    },
};

export default bookingRepository;