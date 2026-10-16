/**
 * src/services/bookingGroup.service.js
 *
 * WHAT THIS MODULE DOES
 * Group (allotment) reservations: holding a block of rooms for one party,
 * confirming it, releasing it, and adding rooms to it later.
 *
 * WHY A GROUP IS BUILT FROM ORDINARY BOOKINGS
 * Each room in the block is a normal `bookings` row with `group_id` set, so
 * availability, the double-booking guards, check-in, payments, invoices and
 * reporting all keep working unchanged. The group adds coordination on top:
 * it owns the dates and the contact, and it moves its members together.
 *
 * WHY CREATION CAN ROLL BACK BY COMPENSATION
 * Booking creation opens its own transaction per reservation (it has to, for
 * the room row lock that prevents double bookings), so a group cannot be one
 * outer transaction around them. Instead:
 *   1. every room is availability-checked before anything is written, which
 *      makes the common failure (a room already taken) happen before the
 *      first insert;
 *   2. if a later step still fails, the rows created so far are deleted and
 *      the group row with them.
 * The alternative - leaving a half-built group - is exactly what an operator
 * would notice as "the block says six rooms but only three exist".
 *
 * COMMUNICATION
 * Routes -> bookingGroup.controller.js -> THIS FILE
 *        -> booking.service.js (reservations), booking.repository.js,
 *           room.repository.js (availability), bookingGroup.repository.js
 * Database tables used: booking_groups, bookings, rooms
 */
import ApiError from '../utils/errors.js';
import bookingGroupRepository from '../repositories/bookingGroup.repository.js';
import { mapBooking } from '../repositories/booking.repository.js';
import roomRepository from '../repositories/room.repository.js';
import bookingService, { validateStay } from './booking.service.js';
import { formatDate, parseDate, nightsBetween } from '../utils/date.js';

/**
 * Rejects a block containing the same room twice, before any database work.
 *
 * A duplicated room is not merely redundant: the second insert would be
 * rejected by the availability check anyway, but only after the first room in
 * the list has already been written. Catching it here keeps the error about
 * the input rather than about a half-finished operation.
 *
 * @param {Array<{roomId: number}>} rooms
 */
function assertDistinctRooms(rooms) {
    if (!Array.isArray(rooms) || rooms.length === 0) {
        throw ApiError.badRequest('A group needs at least one room', 'NO_ROOMS');
    }

    const seen = new Set();
    for (const room of rooms) {
        const id = Number(room.roomId);
        if (seen.has(id)) {
            const label = `Room #${id}`;
            throw ApiError.badRequest(`${label} appears twice in this block`, 'DUPLICATE_ROOM');
        }
        seen.add(id);
    }
}

/**
 * Loads every room and checks it is free for the whole block window.
 *
 * Dates may arrive as strings (from addRooms, reading the group row) or as
 * UTC dates (from create). The availability SQL compares DATE columns, so
 * both shapes are normalised to the same string form before the query, which
 * is what keeps the comparison in date space rather than binding a JavaScript
 * Date object as a datetime literal.
 */
async function assertRoomsAvailable(rooms, checkIn, checkOut) {
    const checkInStr = typeof checkIn === 'string' ? checkIn : formatDate(checkIn);
    const checkOutStr = typeof checkOut === 'string' ? checkOut : formatDate(checkOut);
    const unavailable = [];

    for (const room of rooms) {
        const record = await roomRepository.findById(Number(room.roomId));
        if (!record) {
            throw ApiError.notFound(`Room #${room.roomId} does not exist`, 'ROOM_NOT_FOUND');
        }
        if (!record.isActive) {
            throw ApiError.badRequest(`Room ${record.roomNumber} is retired and cannot be booked`, 'ROOM_RETIRED');
        }

        const available = await roomRepository.isRoomAvailable(record.id, checkInStr, checkOutStr);
        if (!available) unavailable.push(record.roomNumber);
    }

    if (unavailable.length > 0) {
        throw ApiError.conflict(
            `These rooms are already taken for those dates: ${unavailable.join(', ')}`,
            'ROOM_UNAVAILABLE',
        );
    }
}

const bookingGroupService = {
    /**
     * Creates a group block and one reservation per requested room.
     *
     * @param {object} input  Validated payload (see bookingGroup.validators).
     * @param {object} requester Signed in staff member.
     */
    async createGroup(input, requester) {
        const { checkIn, checkOut } = validateStay(input.checkIn, input.checkOut);
        assertDistinctRooms(input.rooms);

        // Nothing is written until every room is known to be free.
        await assertRoomsAvailable(input.rooms, checkIn, checkOut);

        const groupId = await bookingGroupRepository.create({
            groupReference: await bookingGroupRepository.generateReference(),
            name: input.name,
            contactName: input.contactName,
            contactEmail: input.contactEmail,
            contactPhone: input.contactPhone,
            checkIn: formatDate(checkIn),
            checkOut: formatDate(checkOut),
            notes: input.notes,
            createdBy: requester.id,
        });

        const created = [];
        try {
            for (const room of input.rooms) {
                const booking = await bookingService.createBooking({
                    // The block is held by the staff member who created it.
                    // The party is identified by the group's contact details,
                    // exactly as a walk-in reservation taken by phone is.
                    userId: requester.id,
                    roomId: Number(room.roomId),
                    checkIn: formatDate(checkIn),
                    checkOut: formatDate(checkOut),
                    guests: room.guests,
                    adults: room.adults,
                    children: room.children,
                    specialRequests: room.specialRequests || input.notes || undefined,
                    createdBy: requester.id,
                    guestEmail: input.contactEmail,
                    guestName: input.contactName || input.name,
                    groupId,
                });
                created.push(booking.id);
            }
        } catch (error) {
            // Compensate: remove what was created so no half-built block is left.
            for (const bookingId of created) {
                await bookingGroupRepository.removeBooking(bookingId).catch(() => {});
            }
            await bookingGroupRepository.remove(groupId).catch(() => {});
            throw error;
        }

        return this.getGroup(groupId);
    },

    /** Paginated list with room counts and money totals. */
    async listGroups({ page, limit, status, search, sortBy, sortDir }) {
        return bookingGroupRepository.findMany({ page, limit, status, search, sortBy, sortDir });
    },

    /** One group with its reservations. */
    async getGroup(id) {
        const group = await bookingGroupRepository.findById(id);
        if (!group) throw ApiError.notFound('Group not found', 'GROUP_NOT_FOUND');

        const bookings = (await bookingGroupRepository.listBookings(id)).map(mapBooking);
        const start = parseDate(group.checkIn);
        const end = parseDate(group.checkOut);

        return {
            ...group,
            nights: start && end ? nightsBetween(start, end) : 0,
            bookings,
        };
    },

    /**
     * Confirms every pending reservation in the block, then the block itself.
     *
     * Availability is re-checked for every member first: confirming five of
     * six and failing on the last would leave an operator with a block that is
     * neither held nor released.
     */
    async confirmGroup(id, requester) {
        const group = await this.getGroup(id);

        if (group.status === 'cancelled') {
            throw ApiError.badRequest('A cancelled group cannot be confirmed', 'GROUP_CANCELLED');
        }
        if (group.status === 'confirmed') {
            throw ApiError.badRequest('This group is already confirmed', 'ALREADY_CONFIRMED');
        }

        const pending = group.bookings.filter((booking) => booking.status === 'pending');

        for (const booking of pending) {
            const available = await roomRepository.isRoomAvailable(
                booking.roomId,
                booking.checkIn,
                booking.checkOut,
                { excludeBookingId: booking.id },
            );
            if (!available) {
                throw ApiError.conflict(
                    `Room ${booking.roomNumber} is no longer available and the group cannot be confirmed`,
                    'ROOM_UNAVAILABLE',
                );
            }
        }

        for (const booking of pending) {
            await bookingService.confirmBooking(booking.id, requester);
        }

        await bookingGroupRepository.updateStatus(id, 'confirmed', { confirmedAt: new Date() });
        return this.getGroup(id);
    },

    /**
     * Releases every reservation in the block.
     *
     * A guest already in house is not cancellable - their stay has to end at
     * the desk - so the whole group is refused in that case rather than
     * quietly leaving half a block alive.
     */
    async cancelGroup(id, requester, reason) {
        const group = await this.getGroup(id);

        if (group.status === 'cancelled') {
            throw ApiError.badRequest('This group is already cancelled', 'ALREADY_CANCELLED');
        }

        const inHouse = group.bookings.filter((booking) =>
            ['checked_in', 'checked_out'].includes(booking.status),
        );
        if (inHouse.length > 0) {
            throw ApiError.conflict(
                `${inHouse.length} reservation(s) in this group have already started and cannot be cancelled`,
                'GROUP_IN_USE',
            );
        }

        const cancellable = group.bookings.filter((booking) =>
            ['pending', 'confirmed'].includes(booking.status),
        );
        for (const booking of cancellable) {
            await bookingService.cancelBooking(
                booking.id,
                requester,
                reason || `Group ${group.groupReference} cancelled`,
            );
        }

        await bookingGroupRepository.updateStatus(id, 'cancelled', { cancelledAt: new Date() });
        return this.getGroup(id);
    },

    /**
     * Adds rooms to an existing block (the allotment grows).
     * The group's dates always win: an added room joins the block's window
     * rather than bringing its own.
     */
    async addRooms(id, rooms, requester) {
        const group = await this.getGroup(id);

        if (group.status === 'cancelled') {
            throw ApiError.badRequest('Rooms cannot be added to a cancelled group', 'GROUP_CANCELLED');
        }
        assertDistinctRooms(rooms);

        const existing = new Set(group.bookings.map((booking) => Number(booking.roomId)));
        const fresh = rooms.filter((room) => !existing.has(Number(room.roomId)));
        if (fresh.length === 0) {
            throw ApiError.badRequest('Every one of those rooms is already in this group', 'ROOM_ALREADY_IN_GROUP');
        }

        const checkIn = parseDate(group.checkIn);
        const checkOut = parseDate(group.checkOut);
        await assertRoomsAvailable(fresh, checkIn, checkOut);

        const created = [];
        try {
            for (const room of fresh) {
                const booking = await bookingService.createBooking({
                    userId: requester.id,
                    roomId: Number(room.roomId),
                    checkIn: group.checkIn,
                    checkOut: group.checkOut,
                    guests: room.guests,
                    adults: room.adults,
                    children: room.children,
                    specialRequests: room.specialRequests || group.notes || undefined,
                    createdBy: requester.id,
                    guestEmail: group.contactEmail,
                    guestName: group.contactName || group.name,
                    groupId: group.id,
                });
                created.push(booking.id);
            }
        } catch (error) {
            for (const bookingId of created) {
                await bookingGroupRepository.removeBooking(bookingId).catch(() => {});
            }
            throw error;
        }

        return this.getGroup(id);
    },
};

export default bookingGroupService;
