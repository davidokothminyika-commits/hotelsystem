/**
 * src/repositories/folio.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for the guest folio: the append-only charge ledger on a booking
 * (folio_entries) plus the recomputation of the booking's bill from it.
 *
 * WHY THE RECOMPUTE LIVES HERE AND NOT IN THE SERVICE
 * It is one UPDATE driven by one aggregate query, so it belongs beside the
 * table it reads. The service decides *when* to run it (after every post or
 * void); this file guarantees it is *correct* by recomputing from the ledger
 * rather than by adding a delta to a stored number.
 *
 * COMMUNICATION
 * Called by: services/folio.service.js
 * Database tables used: folio_entries, bookings, invoices, users
 * Frontend: /api/folios
 */
import { query, queryOne, execute } from '../config/db.js';
import { PRICING, calculateTotals } from '../config/pricing.js';

const FOLIO_SELECT = `
    SELECT f.*,
           CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
    FROM folio_entries f
    LEFT JOIN users u ON u.id = f.created_by`;

function mapEntry(row) {
    if (!row) return null;
    return {
        id: row.id,
        bookingId: row.booking_id,
        entryType: row.entry_type,
        description: row.description,
        amount: Number(row.amount),
        // The signed effect of the row on the bill, for display code.
        signedAmount: row.entry_type === 'credit' ? -Number(row.amount) : Number(row.amount),
        createdBy: row.created_by,
        createdByName: row.created_by_name,
        voidedAt: row.voided_at,
        voidedBy: row.voided_by,
        voidReason: row.void_reason,
        createdAt: row.created_at,
    };
}

/**
 * Executors that normalise the two driver shapes.
 *
 * `execute()` (the pool) already unwraps `[result, fields]`, while a raw
 * `connection.execute()` does not. A write helper returns the ResultSetHeader
 * either way, and a read helper returns the rows, so every method below can
 * read `result.insertId` or slice rows without caring where it ran.
 */
function rowsRunner(connection) {
    if (!connection) return (sql, params) => query(sql, params);
    return async (sql, params) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
    };
}

function writeRunner(connection) {
    if (!connection) return execute;
    return async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        return result;
    };
}

const folioRepository = {
    /**
     * Appends one ledger row.
     *
     * @param {object} data
     * @param {import('mysql2/promise').PoolConnection} [connection] Joins the
     *   caller's transaction when provided.
     */
    async insert({ bookingId, entryType, description, amount, createdBy }, connection) {
        const run = writeRunner(connection);
        const result = await run(
            `INSERT INTO folio_entries (booking_id, entry_type, description, amount, created_by)
             VALUES (:bookingId, :entryType, :description, :amount, :createdBy)`,
            { bookingId, entryType, description, amount, createdBy: createdBy || null },
        );
        return result.insertId;
    },

    async findById(id) {
        const row = await queryOne(`${FOLIO_SELECT} WHERE f.id = :id`, { id });
        return mapEntry(row);
    },

    /** Every entry on one folio, oldest first, so the ledger reads chronologically. */
    async listForBooking(bookingId) {
        const rows = await query(
            `${FOLIO_SELECT} WHERE f.booking_id = :bookingId ORDER BY f.created_at ASC, f.id ASC`,
            { bookingId },
        );
        return rows.map(mapEntry);
    },

    /** Marks one entry void. Idempotent: a second void writes nothing. */
    async voidEntry(id, { voidedBy, voidReason } = {}, connection) {
        const run = writeRunner(connection);
        const result = await run(
            `UPDATE folio_entries
             SET voided_at = COALESCE(voided_at, NOW()),
                 voided_by = COALESCE(voided_by, :voidedBy),
                 void_reason = COALESCE(void_reason, :voidReason)
             WHERE id = :id AND voided_at IS NULL`,
            { id, voidedBy: voidedBy || null, voidReason: voidReason || null },
        );
        return result.affectedRows > 0;
    },

    /**
     * Recomputes one booking's bill from its room rate plus its live entries.
     *
     * THE INVARIANT
     * `room rate + live charges - live credits`, taxed and serviced exactly
     * like a fresh booking (see src/config/pricing.js), must equal what the
     * bookings row says. Recomputing from the ledger after every change is
     * what keeps a voided entry impossible to double-count, and keeps
     * payments, invoices and reports - all of which read bookings.total_amount
     * - honest without modifications.
     *
     * @param {number} bookingId
     * @param {import('mysql2/promise').PoolConnection} [connection]
     * @returns {object|null} The refreshed money breakdown, or null when the
     *   booking no longer exists.
     */
    async recomputeBooking(bookingId, connection) {
        const run = writeRunner(connection);
        const read = rowsRunner(connection);

        // One aggregate over the booking and its entries. Runs on the caller's
        // connection when there is one, so the ledger rows written in the same
        // transaction are what this reads.
        const rows = await read(
            `SELECT b.price_per_night,
                    b.nights,
                    b.amount_paid,
                    COALESCE(SUM(CASE WHEN f.voided_at IS NULL
                                      THEN CASE f.entry_type WHEN 'charge' THEN f.amount
                                                             ELSE -f.amount END
                                      ELSE 0 END), 0) AS extras
             FROM bookings b
             LEFT JOIN folio_entries f ON f.booking_id = b.id
             WHERE b.id = :bookingId
             GROUP BY b.id`,
            { bookingId },
        );
        const row = (rows || [])[0] || null;
        if (!row) return null;

        const base = Number(row.price_per_night) * Number(row.nights);
        const subtotal = Number((base + Number(row.extras)).toFixed(2));
        const totals = calculateTotals(subtotal);

        await run(
            `UPDATE bookings
             SET subtotal = :subtotal,
                 tax_amount = :taxAmount,
                 service_charge = :serviceCharge,
                 total_amount = :totalAmount
             WHERE id = :bookingId`,
            {
                bookingId,
                subtotal: totals.subtotal,
                taxAmount: totals.taxAmount,
                serviceCharge: totals.serviceCharge,
                totalAmount: totals.totalAmount,
            },
        );

        // Any existing invoice follows the bill, without touching the payment
        // history that decides how much of it is settled.
        await run(
            `UPDATE invoices
             SET subtotal = :subtotal,
                 tax_amount = :taxAmount,
                 service_charge = :serviceCharge,
                 total_amount = :totalAmount,
                 balance_due = GREATEST(0, :totalAmount - amount_paid)
             WHERE booking_id = :bookingId AND status <> 'void'`,
            {
                bookingId,
                subtotal: totals.subtotal,
                taxAmount: totals.taxAmount,
                serviceCharge: totals.serviceCharge,
                totalAmount: totals.totalAmount,
            },
        );

        return {
            id: bookingId,
            pricePerNight: Number(row.price_per_night),
            nights: Number(row.nights),
            amountPaid: Number(row.amount_paid),
            balanceDue: Number((totals.totalAmount - Number(row.amount_paid)).toFixed(2)),
            currency: PRICING.currency,
            ...totals,
        };
    },

    /**
     * Booking summary rows for the folio board.
     *
     * The desk works "who is in house and what do they owe", so live bookings
     * carried their extras aggregated alongside the stored bill.
     */
    async findFoliosWithBalance({ page = 1, limit = 20, search, status }) {
        const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
        const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
        const params = { limit: safeLimit, offset: (safePage - 1) * safeLimit };

        const conditions = ["b.status IN ('pending', 'confirmed', 'checked_in')"];

        if (search) {
            conditions.push(
                '(b.booking_reference LIKE :search OR u.first_name LIKE :search OR u.last_name LIKE :search OR u.email LIKE :search OR r.room_number LIKE :search)',
            );
            params.search = `%${search}%`;
        }
        if (status === 'owing') {
            conditions.push('b.total_amount > b.amount_paid');
        }

        const where = `WHERE ${conditions.join(' AND ')}`;

        const rows = await query(
            `SELECT b.id, b.booking_reference, b.check_in, b.check_out, b.status,
                    b.subtotal, b.tax_amount, b.service_charge, b.total_amount, b.amount_paid,
                    b.user_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number, rt.name AS room_type,
                    (SELECT COUNT(*) FROM folio_entries f
                      WHERE f.booking_id = b.id AND f.voided_at IS NULL) AS entry_count,
                    (SELECT COALESCE(SUM(CASE f.entry_type WHEN 'charge' THEN f.amount ELSE -f.amount END), 0)
                       FROM folio_entries f
                      WHERE f.booking_id = b.id AND f.voided_at IS NULL) AS extras_total
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             ${where}
             ORDER BY b.check_in DESC, b.id ASC
             LIMIT :limit OFFSET :offset`,
            params,
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             ${where}`,
            params,
        );

        return {
            rows: rows.map((row) => {
                const extras = Number(row.extras_total ?? 0);
                return {
                    id: row.id,
                    bookingReference: row.booking_reference,
                    checkIn: row.check_in,
                    checkOut: row.check_out,
                    status: row.status,
                    userId: row.user_id,
                    guestName: row.guest_name,
                    guestEmail: row.guest_email,
                    roomNumber: row.room_number,
                    roomType: row.room_type,
                    // The rate portion of the bill, i.e. the subtotal before
                    // folio entries changed it.
                    roomRate: Number((Number(row.subtotal) - extras).toFixed(2)),
                    extrasTotal: extras,
                    entryCount: Number(row.entry_count),
                    subtotal: Number(row.subtotal),
                    taxAmount: Number(row.tax_amount),
                    serviceCharge: Number(row.service_charge),
                    totalAmount: Number(row.total_amount),
                    amountPaid: Number(row.amount_paid),
                    balanceDue: Number((Number(row.total_amount) - Number(row.amount_paid)).toFixed(2)),
                };
            }),
            total: countRow ? Number(countRow.total) : 0,
            page: safePage,
            limit: safeLimit,
        };
    },
};

export default folioRepository;
