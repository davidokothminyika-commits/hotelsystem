/**
 * src/controllers/room.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for browsing rooms and searching availability.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/room.service.js -> room.repository.js
 * Frontend: public/js/api/rooms.js
 */
import { sendSuccess, sendPaginated, sendCreated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import roomService from '../services/room.service.js';

const roomController = {
    /**
     * GET /api/rooms/availability
     *
     * Declared before /:id so the literal path is not swallowed by the
     * parameterised route. Express matches in registration order.
     */
    availability: asyncHandler(async (req, res) => {
        const result = await roomService.searchAvailability({
            checkIn: req.query.checkIn,
            checkOut: req.query.checkOut,
            guests: req.query.guests,
            roomTypeId: req.query.roomType,
            minPrice: req.query.minPrice,
            maxPrice: req.query.maxPrice,
            page: req.query.page,
            limit: req.query.limit,
            sortBy: req.query.sortBy,
            sortDir: req.query.sortDir,
        });

        return sendPaginated(
            res,
            result.rooms,
            { page: result.page, limit: result.limit, total: result.total },
            result.total === 0
                ? 'No rooms available for the selected dates'
                : `${result.total} room(s) available`,
        );
    }),

    /** GET /api/rooms/types */
    types: asyncHandler(async (req, res) => {
        const roomTypes = await roomService.listRoomTypes();
        return sendSuccess(res, 'Room types retrieved', { roomTypes });
    }),

    /** GET /api/rooms/amenities */
    amenities: asyncHandler(async (req, res) => {
        const amenities = await roomService.listAmenities();
        return sendSuccess(res, 'Amenities retrieved', { amenities });
    }),

    /** GET /api/rooms/status-counts (staff) */
    statusCounts: asyncHandler(async (req, res) => {
        const counts = await roomService.getStatusCounts();
        return sendSuccess(res, 'Room status counts retrieved', { counts });
    }),

    /** GET /api/rooms */
    list: asyncHandler(async (req, res) => {
        const result = await roomService.listRooms({
            page: req.query.page,
            limit: req.query.limit,
            search: req.query.search,
            roomTypeId: req.query.roomType,
            status: req.query.status,
            floor: req.query.floor,
            minPrice: req.query.minPrice,
            maxPrice: req.query.maxPrice,
            sortBy: req.query.sortBy,
            sortDir: req.query.sortDir,
            includeInactive: req.query.includeInactive === 'true',
        });

        return sendPaginated(res, result.rows, { page: req.query.page || 1, limit: req.query.limit || 20, total: result.total });
    }),

    /** GET /api/rooms/:id */
    detail: asyncHandler(async (req, res) => {
        const room = await roomService.getRoom(req.params.id);
        return sendSuccess(res, 'Room retrieved', { room });
    }),

    /** GET /api/rooms/:id/calendar */
    calendar: asyncHandler(async (req, res) => {
        const calendar = await roomService.getRoomAvailabilityCalendar(req.params.id, {
            month: req.query.month,
            guests: req.query.guests,
        });
        return sendSuccess(res, 'Availability retrieved', { calendar });
    }),

    // -------------------------------------------------------------------------
    // Administrative
    // -------------------------------------------------------------------------

    /** POST /api/rooms */
    create: asyncHandler(async (req, res) => {
        const room = await roomService.createRoom(req.validated?.body || req.body);
        return sendCreated(res, 'Room created successfully', { room });
    }),

    /** PATCH /api/rooms/:id */
    update: asyncHandler(async (req, res) => {
        const room = await roomService.updateRoom(req.params.id, req.validated?.body || req.body);
        return sendSuccess(res, 'Room updated successfully', { room });
    }),

    /** PATCH /api/rooms/:id/status */
    updateStatus: asyncHandler(async (req, res) => {
        const room = await roomService.updateRoomStatus(req.params.id, req.body.status);
        return sendSuccess(res, 'Room status updated', { room });
    }),

    /** DELETE /api/rooms/:id */
    remove: asyncHandler(async (req, res) => {
        const result = await roomService.removeRoom(req.params.id);
        return sendSuccess(
            res,
            result.retired
                ? 'Room retired. It has booking history so was deactivated rather than deleted.'
                : 'Room deleted successfully',
            result,
        );
    }),
};

export default roomController;