/**
 * src/repositories/bookingGroup.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for group blocks (booking_groups) and the reservations held inside
 * them.
 *
 * WHY IT IS SEPARATE FROM booking.repository.js
 * A group is its own resource with its own lifecycle (tentative ->
 * confirmed -> cancelled) and its own listing needs. Group queries still read
 * from bookings, but only ever through `bookings.group_id`, so this file owns
 * the join and booking.repository.js does not have to know groups exist.
 *
 * COMMUNICATION
 * Called by: services/bookingGroup.service.js
 * Database tables used: booking_groups, bookings, rooms, users
 * Frontend: /api/booking-groups
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolvePagination, resolveSort } from './base.repository.js';

const SORTABLE_GROUP_COLUMNS = ['g.created_at', 'g.check_in', 'g.name', 'g.status'];

function mapGroup(row) {
    if (!row) return null;
    return {
        id: row.id,
        groupReference: row.group_reference,
        name: row.name,
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        contactPhone: row.contact_phone,
        checkIn: row.check_in,
        checkOut: row.check_out,
        status: row.status,
        notes: row.notes,
        createdBy: row.created_by,
        confirmedAt: row.confirmed_at,
        cancelledAt: row.cancelled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Aggregates. Absent on a plain row, so they default to null rather
        // than silently reporting a full block.
        roomCount: row.room_count === undefined || row.room_count === null ? null : Number(row.room_count),
        nights: row.nights === undefined || row.nights === null ? null : Number(row.nights),
        totalAmount: row.total_amount === undefined || row.total_amount === null ? null : Number(row.total_amount),
        amountPaid: row.amount_paid === undefined || row.amount_paid === null ? null : Number(row.amount_paid),
        // Joined display fields.
        createdByName: row.created_by_name || null,
    };
}

const bookingGroupRepository = {
    /**
     * Generates a unique group reference, e.g. GRP7F2K9XA.
     *
     * Format: 'GRP' + 5 base36 timestamp characters + 2 random, which fills the
     * CHAR(10) column exactly. Same reasoning as the booking reference: the
     * timestamp sorts roughly by creation and the unique index makes a
     * collision impossible rather than unlikely.
     */
    async generateReference() {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const timestamp = Date.now().toString(36).toUpperCase().padStart(6, '0').slice(-5);
            let random = '';
            for (let i = 0; i < 2; i += 1) {
                random += alphabet[Math.floor(Math.random() * alphabet.length)];
            }

            const reference = `GRP${timestamp}${random}`;
            const existing = await queryOne(
                'SELECT id FROM booking_groups WHERE group_reference = :reference',
                { reference },
            );
            if (!existing) return reference;
        }

        throw new Error('Unable to generate a unique group reference');
    },

    async create({ groupReference, name, contactName, contactEmail, contactPhone, checkIn, checkOut, notes, createdBy }) {
        const result = await execute(
            `INSERT INTO booking_groups
                (group_reference, name, contact_name, contact_email, contact_phone,
                 check_in, check_out, notes, created_by)
             VALUES
                (:groupReference, :name, :contactName, :contactEmail, :contactPhone,
                 :checkIn, :checkOut, :notes, :createdBy)`,
            {
                groupReference,
                name,
                contactName: contactName || null,
                contactEmail: contactEmail || null,
                contactPhone: contactPhone || null,
                checkIn,
                checkOut,
                notes: notes || null,
                createdBy: createdBy || null,
            },
        );
        return result.insertId;
    },

    async findById(id) {
        const row = await queryOne(
            `SELECT g.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    COUNT(b.id) AS room_count,
                    COALESCE(SUM(b.total_amount), 0) AS total_amount,
                    COALESCE(SUM(b.amount_paid), 0) AS amount_paid
             FROM booking_groups g
             LEFT JOIN users u ON u.id = g.created_by
             LEFT JOIN bookings b ON b.group_id = g.id
             WHERE g.id = :id
             GROUP BY g.id`,
            { id },
        );
        return mapGroup(row);
    },

    /**
     * Paginated group list with room counts and money totals, so an operator
     * can see "which blocks are half full and what they are worth" without
     * opening every one.
     */
    async findMany({ page = 1, limit = 20, status, search, sortBy, sortDir }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = { limit: pagination.limit, offset: pagination.offset };

        if (status) {
            conditions.push({ sql: 'g.status = :status', params: { status } });
        }
        if (search) {
            conditions.push({
                sql: '(g.group_reference LIKE :search OR g.name LIKE :search OR g.contact_name LIKE :search OR g.contact_email LIKE :search)',
                params: { search: `%${search}%` },
            });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        const sort = resolveSort(sortBy, sortDir, SORTABLE_GROUP_COLUMNS, 'g.created_at', 'DESC');

        const rows = await query(
            `SELECT g.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    COUNT(b.id) AS room_count,
                    COALESCE(SUM(b.total_amount), 0) AS total_amount,
                    COALESCE(SUM(b.amount_paid), 0) AS amount_paid
             FROM booking_groups g
             LEFT JOIN users u ON u.id = g.created_by
             LEFT JOIN bookings b ON b.group_id = g.id
             ${where}
             GROUP BY g.id
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM booking_groups g ${where}`,
            filterParams,
        );

        return {
            rows: rows.map(mapGroup),
            total: countRow ? Number(countRow.total) : 0,
            page: pagination.page,
            limit: pagination.limit,
        };
    },

    /** Every reservation inside one group, newest room number first. */
    async listBookings(groupId) {
        const rows = await query(
            `SELECT b.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number, rt.name AS room_type, r.image AS room_image
             FROM bookings b
             JOIN users u ON u.id = b.user_id
             JOIN rooms r ON r.id = b.room_id
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE b.group_id = :groupId
             ORDER BY r.room_number ASC`,
            { groupId },
        );
        return rows;
    },

    async updateStatus(id, status, extra = {}) {
        await execute(
            `UPDATE booking_groups SET
                status = :status,
                confirmed_at = COALESCE(:confirmedAt, confirmed_at),
                cancelled_at = COALESCE(:cancelledAt, cancelled_at)
             WHERE id = :id`,
            {
                id,
                status,
                confirmedAt: extra.confirmedAt || null,
                cancelledAt: extra.cancelledAt || null,
            },
        );
        return this.findById(id);
    },

    /** Attaches an existing booking to the group. Used when adding rooms. */
    async attachBooking(bookingId, groupId) {
        await execute('UPDATE bookings SET group_id = :groupId WHERE id = :bookingId', {
            bookingId,
            groupId,
        });
    },

    /**
     * Removes a booking that was created as part of a group that then failed.
     *
     * Compensation only: a booking with a payment, an invoice or a check-in
     * must never reach this method, which is why the callers delete only rows
     * they inserted seconds earlier in the same operation.
     */
    async removeBooking(bookingId) {
        await execute('DELETE FROM bookings WHERE id = :bookingId', { bookingId });
    },

    /** Removes a group row during the same compensation path. */
    async remove(id) {
        await execute('DELETE FROM booking_groups WHERE id = :id', { id });
    },
};

export default bookingGroupRepository;
