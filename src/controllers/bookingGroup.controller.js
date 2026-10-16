/**
 * src/controllers/bookingGroup.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for group (allotment) reservations.
 *
 * WHY EVERY HANDLER PASSES req.user INTO THE SERVICE
 * The service records who created, confirmed or released the block. The audit
 * trail for a cancelled conference block has to name the person who released
 * six rooms, not just that it happened.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/bookingGroup.service.js
 * Frontend: public/js/pages/admin/groups.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import bookingGroupService from '../services/bookingGroup.service.js';

const bookingGroupController = {
    /** GET /api/booking-groups */
    list: asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await bookingGroupService.listGroups({
            page: query.page,
            limit: query.limit,
            status: query.status,
            search: query.search,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Groups retrieved',
        );
    }),

    /** POST /api/booking-groups */
    create: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const group = await bookingGroupService.createGroup(payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_GROUP_CREATED,
            entity: 'booking_groups',
            entityId: group.id,
            req,
            metadata: {
                group_reference: group.groupReference,
                rooms: group.roomCount,
                check_in: group.checkIn,
                check_out: group.checkOut,
            },
        });

        return sendCreated(res, 'Group created', { group });
    }),

    /** GET /api/booking-groups/:id */
    detail: asyncHandler(async (req, res) => {
        const group = await bookingGroupService.getGroup(req.params.id);
        return sendSuccess(res, 'Group retrieved', { group });
    }),

    /** POST /api/booking-groups/:id/confirm */
    confirm: asyncHandler(async (req, res) => {
        const group = await bookingGroupService.confirmGroup(req.params.id, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_GROUP_CONFIRMED,
            entity: 'booking_groups',
            entityId: group.id,
            req,
            metadata: { group_reference: group.groupReference, rooms: group.roomCount },
        });

        return sendSuccess(res, 'Group confirmed', { group });
    }),

    /** POST /api/booking-groups/:id/cancel */
    cancel: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const group = await bookingGroupService.cancelGroup(req.params.id, req.user, payload.reason);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_GROUP_CANCELLED,
            entity: 'booking_groups',
            entityId: group.id,
            req,
            metadata: {
                group_reference: group.groupReference,
                rooms: group.roomCount,
                reason: payload.reason || null,
            },
        });

        return sendSuccess(res, 'Group cancelled', { group });
    }),

    /** POST /api/booking-groups/:id/rooms */
    addRooms: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const group = await bookingGroupService.addRooms(req.params.id, payload.rooms, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BOOKING_GROUP_CREATED,
            entity: 'booking_groups',
            entityId: group.id,
            req,
            metadata: { group_reference: group.groupReference, added_rooms: payload.rooms.length },
        });

        return sendSuccess(res, 'Rooms added to group', { group });
    }),
};

export default bookingGroupController;
