/**
 * src/controllers/maintenance.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for repair tickets.
 *
 * WHY THE SERVICE CALL IS MADE BEFORE THE AUDIT WRITE
 * recordAudit never throws, so ordering it first would risk logging an action
 * that then failed. Logging what actually happened keeps the trail true.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/maintenance.service.js
 * Frontend: public/js/pages/staff/maintenance.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import maintenanceService from '../services/maintenance.service.js';

const maintenanceController = {
    /** GET /api/maintenance */
    list: asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await maintenanceService.listTickets({
            page: query.page,
            limit: query.limit,
            status: query.status,
            openOnly: query.openOnly === 'true' || query.openOnly === '1',
            priority: query.priority,
            roomId: query.roomId,
            search: query.search,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Tickets retrieved',
        );
    }),

    /** GET /api/maintenance/counts */
    counts: asyncHandler(async (_req, res) => {
        const counts = await maintenanceService.getCounts();
        return sendSuccess(res, 'Ticket counts retrieved', { counts });
    }),

    /** GET /api/maintenance/:id */
    detail: asyncHandler(async (req, res) => {
        const ticket = await maintenanceService.getTicket(req.params.id);
        return sendSuccess(res, 'Ticket retrieved', { ticket });
    }),

    /** POST /api/maintenance */
    create: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const ticket = await maintenanceService.createTicket(payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MAINTENANCE_TICKET_CREATED,
            entity: 'maintenance_tickets',
            entityId: ticket.id,
            req,
            metadata: {
                ticket_number: ticket.ticketNumber,
                room_id: ticket.roomId,
                room_number: ticket.roomNumber,
                priority: ticket.priority,
            },
        });

        return sendCreated(res, 'Ticket raised', { ticket });
    }),

    /** PATCH /api/maintenance/:id */
    update: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const ticket = await maintenanceService.updateTicket(req.params.id, payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MAINTENANCE_TICKET_UPDATED,
            entity: 'maintenance_tickets',
            entityId: ticket.id,
            req,
            metadata: {
                ticket_number: ticket.ticketNumber,
                status: ticket.status,
                priority: ticket.priority,
                assigned_to: ticket.assignedToName || null,
            },
        });

        return sendSuccess(res, 'Ticket updated', { ticket });
    }),
};

export default maintenanceController;
