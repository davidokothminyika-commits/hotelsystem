/**
 * src/services/room.service.js
 *
 * WHAT THIS MODULE DOES
 * Room browsing, filtering and availability search for guests and staff.
 *
 * WHY IT EXISTS
 * The availability rules (which rooms may be offered, for which dates, to how
 * many guests) are hotel policy rather than SQL mechanics. Keeping them here
 * means the frontend, the tests and any future channel (a mobile app, a
 * booking widget on another site) all get the same answer.
 *
 * COMMUNICATION
 * Browser -> /api/rooms/* -> rooms.controller.js -> THIS FILE
 *        -> room.repository.js
 * Database tables used: rooms, room_types, amenities, room_amenities, bookings
 * Frontend: public/js/api/rooms.js, components/room-card.html
 */
import ApiError from '../utils/errors.js';
import { parseDate, formatDate, nightsBetween, today } from '../utils/date.js';
import { calculateTotals } from '../config/pricing.js';
import roomRepository from '../repositories/room.repository.js';
import { resolvePagination } from '../repositories/base.repository.js';

const roomService = {
    /**
     * Searches rooms available for a date window.
     *
     * Both the availability test and the filtering happen in SQL, never in
     * the browser. Frontend-only filtering would be trivially bypassed and
     * could offer a room that is already taken.
     *
     * When dates are supplied the response includes the stay length and the
     * total price for that stay, so the room card can show a real figure
     * rather than only the nightly rate.
     */
    async searchAvailability({ checkIn, checkOut, guests, roomTypeId, minPrice, maxPrice, page, limit, sortBy, sortDir }) {
        const pagination = resolvePagination({ page, limit });

        let stay = null;
        let start = null;
        let end = null;

        if (checkIn && checkOut) {
            start = parseDate(checkIn);
            end = parseDate(checkOut);

            if (!start || !end) {
                throw ApiError.badRequest('Check-in and check-out must be valid dates', 'INVALID_DATE');
            }
            if (end <= start) {
                throw ApiError.badRequest('Check-out must be after check-in', 'INVALID_DATE_RANGE');
            }
            if (start < today()) {
                throw ApiError.badRequest('Check-in cannot be in the past', 'DATE_IN_PAST');
            }
            stay = { nights: nightsBetween(start, end), checkIn: formatDate(start), checkOut: formatDate(end) };
        }

        const result = await roomRepository.findAvailable({
            checkIn: start || today(),
            // With no dates supplied the window is a single day, which keeps
            // the SQL shape identical instead of needing a second query.
            checkOut: end || formatDate(new Date(today().getTime() + 86_400_000)),
            guests: Number(guests) || 1,
            roomTypeId,
            minPrice,
            maxPrice,
            page: pagination.page,
            limit: pagination.limit,
            sortBy,
            sortDir,
        });

        return {
            rooms: result.rows.map((room) => ({
                ...room,
                // Price for the requested stay, not just the nightly rate.
                stayTotal: stay ? calculateTotals(room.pricePerNight * stay.nights).totalAmount : null,
            })),
            total: result.total,
            page: pagination.page,
            limit: pagination.limit,
            search: stay
                ? { ...stay, guests: Number(guests) || 1 }
                : null,
        };
    },

    /** General room listing used by the admin rooms screen. */
    async listRooms(options) {
        return roomRepository.findMany(options);
    },

    async getRoom(id) {
        const room = await roomRepository.findById(id);
        if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
        return room;
    },

    /**
     * Returns a room plus the dates around the requested stay that are
     * already taken, so the booking form can grey them out before the guest
     * reaches the confirm step.
     *
     * Each occupied range is expanded into individual nights because that is
     * what the calendar component needs to render.
     */
    async getRoomAvailabilityCalendar(id, { month, guests = 2 }) {
        const room = await this.getRoom(id);

        const start = month ? parseDate(`${month}-01`) : new Date(today().getFullYear(), today().getMonth(), 1);
        if (!start) throw ApiError.badRequest('Month must be in YYYY-MM format', 'INVALID_MONTH');

        // Show the selected month plus the next one, so a guest can see
        // availability beyond the month boundary.
        const end = new Date(start.getFullYear(), start.getMonth() + 2, 0);

        const ranges = await roomRepository.getOccupiedRanges(id, formatDate(start), formatDate(end));

        // Expand [check_in, check_out) into the individual nights occupied.
        const occupiedNights = new Set();
        for (const range of ranges) {
            const cursor = new Date(range.check_in);
            const last = new Date(range.check_out);
            while (cursor < last) {
                occupiedNights.add(formatDate(cursor));
                cursor.setDate(cursor.getDate() + 1);
            }
        }

        return {
            room,
            month: formatDate(start).slice(0, 7),
            from: formatDate(start),
            to: formatDate(end),
            guests: Number(guests),
            occupiedNights: [...occupiedNights].sort(),
        };
    },

    async listRoomTypes(options) {
        const types = await roomRepository.listRoomTypes(options);
        return types.map((type) => ({
            id: type.id,
            name: type.name,
            slug: type.slug,
            description: type.description,
            basePrice: Number(type.base_price),
            maxCapacity: type.max_capacity,
            sizeSqm: type.size_sqm,
            bedConfiguration: type.bed_configuration,
            image: type.image,
            roomCount: Number(type.room_count || 0),
            fromPrice: type.from_price !== null ? Number(type.from_price) : Number(type.base_price),
        }));
    },

    async getRoomType(id) {
        const type = await roomRepository.findRoomTypeById(id);
        if (!type) throw ApiError.notFound('Room type not found', 'ROOM_TYPE_NOT_FOUND');
        return type;
    },

    async createRoom(data) {
        const id = await roomRepository.create(data);
        if (Array.isArray(data.amenityIds) && data.amenityIds.length > 0) {
            await roomRepository.replaceAmenities(id, data.amenityIds);
        }
        return roomRepository.findById(id);
    },

    async updateRoom(id, data) {
        const room = await roomRepository.findById(id);
        if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');

        const updated = await roomRepository.update(id, data);
        if (Array.isArray(data.amenityIds)) {
            await roomRepository.replaceAmenities(id, data.amenityIds);
        }
        return updated;
    },

    async updateRoomStatus(id, status) {
        const room = await roomRepository.findById(id);
        if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');

        return roomRepository.updateStatus(id, status);
    },

    /**
     * Retires a room.
     * This is a soft delete: the row survives so that years of booking history
     * and invoices still resolve to a real room. Hard deletion would be blocked
     * by the foreign keys anyway, which is the database protecting the records.
     */
    async removeRoom(id) {
        const room = await roomRepository.findById(id);
        if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');

        const { queryOne } = await import('../config/db.js');
        const row = await queryOne('SELECT COUNT(*) AS total FROM bookings WHERE room_id = :id', { id });

        if (Number(row.total) > 0) {
            await roomRepository.deactivate(id);
            return { retired: true, bookingHistory: Number(row.total) };
        }

        await roomRepository.delete(id);
        return { retired: false, bookingHistory: 0 };
    },

    async listAmenities() {
        return roomRepository.listAmenities();
    },

    async getStatusCounts() {
        return roomRepository.getStatusCounts();
    },

    async getHousekeepingBoard() {
        const rooms = await roomRepository.getHousekeepingBoard();
        return {
            rooms,
            summary: {
                needsCleaning: rooms.filter((room) => room.status === 'cleaning').length,
                maintenance: rooms.filter((room) => room.status === 'maintenance').length,
                ready: rooms.filter((room) => room.status === 'available').length,
                occupied: rooms.filter((room) => room.status === 'occupied').length,
                reserved: rooms.filter((room) => room.status === 'reserved').length,
            },
        };
    },

    async createRoomType(data) {
        return roomRepository.createRoomType(data);
    },

    async updateRoomType(id, data) {
        await roomRepository.updateRoomType(id, data);
        return this.getRoomType(id);
    },
};

export default roomService;