/**
 * src/repositories/room.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for rooms, room types and amenities.
 *
 * WHY IT EXISTS
 * The availability query is the most important query in a hotel system. It has
 * to combine inventory, booking overlap and filters correctly and stay fast as
 * booking volume grows. Keeping it here, with its reasoning documented, means
 * it can be reviewed and optimised in one place.
 *
 * COMMUNICATION
 * Called by: services/room.service.js, services/booking.service.js
 * Database tables used: rooms, room_types, amenities, room_amenities, bookings
 * Frontend access: /api/rooms, /api/rooms/availability
 */
import { query, queryOne, execute } from '../config/db.js';
import { parseJsonColumn } from '../utils/json.js';
import { resolvePagination, resolveSort } from './base.repository.js';

/** Columns safe to expose for a room listing. */
const ROOM_COLUMNS = `
    r.id, r.room_number, r.floor, r.capacity, r.price_per_night,
    r.description, r.status, r.image, r.is_active,
    rt.id AS room_type_id, rt.name AS room_type, rt.slug AS room_type_slug,
    rt.size_sqm, rt.bed_configuration, rt.image AS room_type_image
`;

/** Columns a room listing may be sorted by. */
const SORTABLE_ROOM_COLUMNS = ['r.price_per_night', 'r.capacity', 'r.room_number', 'r.floor', 'rt.name', 'r.created_at'];

export function mapRoom(row) {
    if (!row) return null;
    return {
        id: row.id,
        roomNumber: row.room_number,
        floor: row.floor,
        capacity: row.capacity,
        pricePerNight: Number(row.price_per_night),
        description: row.description,
        status: row.status,
        // A room usually has no photograph of its own, only its type does, so
        // the type image is the fallback. Without it every room card renders
        // the grey placeholder and the availability grid looks empty.
        image: row.image || row.room_type_image || null,
        isActive: Boolean(row.is_active),
        roomType: {
            id: row.room_type_id,
            name: row.room_type,
            slug: row.room_type_slug,
            sizeSqm: row.size_sqm,
            bedConfiguration: row.bed_configuration,
            image: row.room_type_image || null,
        },
        // mysql2 returns this JSON aggregate as an already-parsed array, so it must
        // not be passed to JSON.parse a second time.
        amenities: parseJsonColumn(row.amenities, []),
    };
}

const roomRepository = {
    /**
     * Finds rooms available for a date range.
     *
     * HOW DOUBLE BOOKING IS PREVENTED
     * A booking occupies nights, not days. A guest arriving on the 10th and
     * leaving on the 12th occupies the nights of the 10th and 11th, so the
     * room is free again on the 12th. Overlap is therefore:
     *
     *     existing.check_in < requested.check_out
     *     AND existing.check_out > requested.check_in
     *
     * Using `<=` instead of `<` would incorrectly block a guest arriving on
     * the same day another guest leaves, which is the single most common
     * booking error in hotel systems.
     *
     * Cancelled bookings are excluded because they no longer occupy the room.
     *
     * The `ix_bookings_room_dates` index (room_id, check_in, check_out) lets
     * MySQL resolve this with an index range scan rather than a full scan.
     *
     * @param {object} params
     * @param {Date} params.checkIn
     * @param {Date} params.checkOut
     * @param {number} params.guests
     * @param {string} [params.roomTypeId]
     * @param {number} [params.minPrice]
     * @param {number} [params.maxPrice]
     */
    async findAvailable({ checkIn, checkOut, guests, roomTypeId, minPrice, maxPrice, page, limit, sortBy, sortDir }) {
        const conditions = [
            'r.is_active = 1',
            // Not currently out of service. A room under maintenance or being
            // cleaned cannot be offered even if its dates are free.
            `r.status IN ('available', 'reserved')`,
            'r.capacity >= :guests',
            // The overlap test. Parameters, never concatenated.
            `NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.room_id = r.id
                  AND b.status IN ('pending', 'confirmed', 'checked_in')
                  AND b.check_in < :checkOut
                  AND b.check_out > :checkIn
            )`,
        ];

        const params = {
            checkIn,
            checkOut,
            guests,
            page,
            limit,
        };

        if (roomTypeId) {
            conditions.push('r.room_type_id = :roomTypeId');
            params.roomTypeId = roomTypeId;
        }
        if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
            conditions.push('r.price_per_night >= :minPrice');
            params.minPrice = Number(minPrice);
        }
        if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
            conditions.push('r.price_per_night <= :maxPrice');
            params.maxPrice = Number(maxPrice);
        }

        const where = conditions.join(' AND ');
        const sort = resolveSort(sortBy, sortDir, SORTABLE_ROOM_COLUMNS, 'r.price_per_night');

        const rows = await query(
            `SELECT ${ROOM_COLUMNS},
                    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'name', a.name, 'icon', a.icon))
                     FROM room_amenities ra JOIN amenities a ON a.id = ra.amenity_id
                     WHERE ra.room_id = r.id) AS amenities
             FROM rooms r
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE ${where}
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, params, { offset: (page - 1) * limit }),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
             WHERE ${where}`,
            params,
        );

        return {
            rows: rows.map(mapRoom),
            total: countRow ? Number(countRow.total) : 0,
        };
    },

    /**
     * Checks whether one specific room is free for a date range.
     *
     * @param {number} roomId
     * @param {Date|string} checkIn
     * @param {Date|string} checkOut
     * @param {object} [options]
     * @param {number} [options.excludeBookingId] Ignore this booking when counting conflicts.
     *   Required when re-checking a booking that already exists: otherwise the
     *   booking conflicts with itself and every confirmation is rejected with
     *   "room unavailable".
     * @param {import('mysql2/promise').PoolConnection} [options.connection]
     */
    async isRoomAvailable(roomId, checkIn, checkOut, { excludeBookingId, connection } = {}) {
        const conditions = [
            'room_id = :roomId',
            "status IN ('pending', 'confirmed', 'checked_in')",
            'check_in < :checkOut',
            'check_out > :checkIn',
        ];

        const params = { roomId, checkIn, checkOut };

        if (excludeBookingId) {
            // The booking being edited must not count as its own conflict.
            conditions.push('id <> :excludeBookingId');
            params.excludeBookingId = excludeBookingId;
        }

        const sql = `SELECT COUNT(*) AS conflicts FROM bookings WHERE ${conditions.join(' AND ')}`;

        if (connection) {
            const [rows] = await connection.execute(sql, params);
            return Number(rows[0].conflicts) === 0;
        }

        const row = await queryOne(sql, params);
        return row ? Number(row.conflicts) === 0 : true;
    },

    /** Generic room listing with filters, used by the admin rooms screen. */
    async findMany({ page = 1, limit = 20, search, roomTypeId, status, minPrice, maxPrice, floor, sortBy, sortDir, includeInactive }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = { limit: pagination.limit, offset: pagination.offset };

        // Every entry is an object with `sql` and optional `params`. Pushing a
        // bare string here once produced `WHERE  AND ...`, because the join
        // below reads c.sql.
        if (!includeInactive) {
            conditions.push({ sql: 'r.is_active = 1', params: {} });
        }

        if (search) {
            conditions.push({
                sql: '(r.room_number LIKE :search OR r.description LIKE :search)',
                params: { search: `%${search}%` },
            });
        }
        if (roomTypeId) {
            conditions.push({ sql: 'r.room_type_id = :roomTypeId', params: { roomTypeId } });
        }
        if (status) {
            conditions.push({ sql: 'r.status = :status', params: { status } });
        }
        if (floor) {
            conditions.push({ sql: 'r.floor = :floor', params: { floor: Number(floor) } });
        }
        if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
            conditions.push({ sql: 'r.price_per_night >= :minPrice', params: { minPrice: Number(minPrice) } });
        }
        if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
            conditions.push({ sql: 'r.price_per_night <= :maxPrice', params: { maxPrice: Number(maxPrice) } });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        const sort = resolveSort(sortBy, sortDir, SORTABLE_ROOM_COLUMNS, 'r.room_number');

        const rows = await query(
            `SELECT ${ROOM_COLUMNS},
                    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'name', a.name, 'icon', a.icon))
                     FROM room_amenities ra JOIN amenities a ON a.id = ra.amenity_id
                     WHERE ra.room_id = r.id) AS amenities
             FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
             ${where}
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id ${where}`,
            filterParams,
        );

        return { rows: rows.map(mapRoom), total: countRow ? Number(countRow.total) : 0 };
    },

    async findById(id) {
        const row = await queryOne(
            `SELECT ${ROOM_COLUMNS},
                    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'name', a.name, 'icon', a.icon, 'description', a.description))
                     FROM room_amenities ra JOIN amenities a ON a.id = ra.amenity_id
                     WHERE ra.room_id = r.id) AS amenities
             FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.id = :id`,
            { id },
        );
        return mapRoom(row);
    },

    async findByRoomNumber(roomNumber) {
        const row = await queryOne(
            `SELECT ${ROOM_COLUMNS} FROM rooms r
             JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.room_number = :roomNumber`,
            { roomNumber },
        );
        return mapRoom(row);
    },

    async create({ roomNumber, roomTypeId, floor, capacity, pricePerNight, description, status, image, isActive }) {
        const result = await execute(
            `INSERT INTO rooms (room_number, room_type_id, floor, capacity, price_per_night, description, status, image, is_active)
             VALUES (:roomNumber, :roomTypeId, :floor, :capacity, :pricePerNight, :description, :status, :image, :isActive)`,
            {
                roomNumber,
                roomTypeId,
                floor,
                capacity,
                pricePerNight,
                description: description || null,
                status: status || 'available',
                image: image || null,
                isActive: isActive === false ? 0 : 1,
            },
        );
        return result.insertId;
    },

    async update(id, { roomNumber, roomTypeId, floor, capacity, pricePerNight, description, status, image, isActive }) {
        await execute(
            `UPDATE rooms SET
                room_number = COALESCE(:roomNumber, room_number),
                room_type_id = COALESCE(:roomTypeId, room_type_id),
                floor = COALESCE(:floor, floor),
                capacity = COALESCE(:capacity, capacity),
                price_per_night = COALESCE(:pricePerNight, price_per_night),
                description = COALESCE(:description, description),
                status = COALESCE(:status, status),
                image = COALESCE(:image, image),
                is_active = COALESCE(:isActive, is_active)
             WHERE id = :id`,
            {
                id,
                roomNumber: roomNumber ?? null,
                roomTypeId: roomTypeId ?? null,
                floor: floor ?? null,
                capacity: capacity ?? null,
                pricePerNight: pricePerNight ?? null,
                description: description ?? null,
                status: status ?? null,
                image: image ?? null,
                isActive: isActive === undefined || isActive === null ? null : isActive ? 1 : 0,
            },
        );
        return this.findById(id);
    },

    async updateStatus(id, status) {
        await execute('UPDATE rooms SET status = :status WHERE id = :id', { id, status });
        return this.findById(id);
    },

    /** Soft delete: keeps the room row so booking history stays intact. */
    async deactivate(id) {
        await execute('UPDATE rooms SET is_active = 0 WHERE id = :id', { id });
    },

    async delete(id) {
        const result = await execute('DELETE FROM rooms WHERE id = :id', { id });
        return result.affectedRows > 0;
    },

    async replaceAmenities(roomId, amenityIds) {
        await execute('DELETE FROM room_amenities WHERE room_id = :roomId', { roomId });
        for (const amenityId of amenityIds) {
            await execute(
                'INSERT IGNORE INTO room_amenities (room_id, amenity_id) VALUES (:roomId, :amenityId)',
                { roomId, amenityId },
            );
        }
    },

    // -------------------------------------------------------------------------
    // Room types and amenities
    // -------------------------------------------------------------------------

    async listRoomTypes({ includeInactive = false } = {}) {
        return query(
            `SELECT rt.*,
                    (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id AND r.is_active = 1) AS room_count,
                    (SELECT MIN(r.price_per_night) FROM rooms r WHERE r.room_type_id = rt.id AND r.is_active = 1) AS from_price
             FROM room_types rt
             ${includeInactive ? '' : 'WHERE rt.is_active = 1'}
             ORDER BY rt.base_price ASC`,
        );
    },

    async findRoomTypeById(id) {
        return queryOne('SELECT * FROM room_types WHERE id = :id', { id });
    },

    async createRoomType({ name, slug, description, basePrice, maxCapacity, sizeSqm, bedConfiguration, image }) {
        const result = await execute(
            `INSERT INTO room_types (name, slug, description, base_price, max_capacity, size_sqm, bed_configuration, image)
             VALUES (:name, :slug, :description, :basePrice, :maxCapacity, :sizeSqm, :bedConfiguration, :image)`,
            { name, slug, description: description || null, basePrice, maxCapacity, sizeSqm: sizeSqm || null, bedConfiguration: bedConfiguration || null, image: image || null },
        );
        return result.insertId;
    },

    async updateRoomType(id, fields) {
        await execute(
            `UPDATE room_types SET
                name = COALESCE(:name, name),
                description = COALESCE(:description, description),
                base_price = COALESCE(:basePrice, base_price),
                max_capacity = COALESCE(:maxCapacity, max_capacity),
                size_sqm = COALESCE(:sizeSqm, size_sqm),
                bed_configuration = COALESCE(:bedConfiguration, bed_configuration),
                image = COALESCE(:image, image),
                is_active = COALESCE(:isActive, is_active)
             WHERE id = :id`,
            {
                id,
                name: fields.name ?? null,
                description: fields.description ?? null,
                basePrice: fields.basePrice ?? null,
                maxCapacity: fields.maxCapacity ?? null,
                sizeSqm: fields.sizeSqm ?? null,
                bedConfiguration: fields.bedConfiguration ?? null,
                image: fields.image ?? null,
                isActive: fields.isActive === undefined || fields.isActive === null ? null : fields.isActive ? 1 : 0,
            },
        );
    },

    async listAmenities() {
        return query('SELECT id, name, icon, description FROM amenities ORDER BY name ASC');
    },

    /**
     * Date ranges that occupy a room, used to build the booking calendar so
     * unavailable nights are shown as unavailable rather than discovered on
     * submit.
     *
     * @param {number} roomId
     * @param {Date} from
     * @param {Date} to
     */
    async getOccupiedRanges(roomId, from, to) {
        return query(
            `SELECT check_in, check_out, status, booking_reference
             FROM bookings
             WHERE room_id = :roomId
               AND status IN ('pending', 'confirmed', 'checked_in')
               AND check_in <= :to
               AND check_out >= :from
             ORDER BY check_in ASC`,
            { roomId, from, to },
        );
    },

    /**
     * Operational counts for the housekeeping and admin dashboards.
     */
    async getStatusCounts() {
        const rows = await query(
            `SELECT status, COUNT(*) AS total FROM rooms WHERE is_active = 1 GROUP BY status`,
        );
        const counts = { available: 0, occupied: 0, reserved: 0, maintenance: 0, cleaning: 0 };
        for (const row of rows) counts[row.status] = Number(row.total);
        counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
        return counts;
    },

    /** Rooms for the housekeeping board, with the current guest where relevant. */
    async getHousekeepingBoard() {
        const rows = await query(
            `SELECT r.id, r.room_number, r.floor, r.status, r.capacity,
                    rt.name AS room_type,
                    (SELECT CONCAT(u.first_name, ' ', u.last_name)
                     FROM bookings b JOIN users u ON u.id = b.user_id
                     WHERE b.room_id = r.id AND b.status = 'checked_in'
                     LIMIT 1) AS current_guest,
                    (SELECT b.check_out FROM bookings b
                     WHERE b.room_id = r.id AND b.status = 'checked_in' LIMIT 1) AS current_checkout
             FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.is_active = 1
             ORDER BY FIELD(r.status, 'maintenance', 'cleaning', 'available', 'reserved', 'occupied'), r.room_number ASC`,
        );

        return rows.map((row) => ({
            id: row.id,
            roomNumber: row.room_number,
            floor: row.floor,
            status: row.status,
            capacity: row.capacity,
            roomType: row.room_type,
            currentGuest: row.current_guest,
            currentCheckout: row.current_checkout,
        }));
    },
};

export default roomRepository;