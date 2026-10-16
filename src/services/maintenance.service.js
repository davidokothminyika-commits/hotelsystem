/**
 * src/services/maintenance.service.js
 *
 * WHAT THIS MODULE DOES
 * Repair work orders: raise a ticket against a room (or a public area),
 * assign it, work it, resolve it, and keep the room's sellable status honest
 * while all that happens.
 *
 * WHY THE ROOM STATUS IS AUTOMATED
 * A room with an open repair should not be sold, and a freshly repaired room
 * still needs housekeeping to see it before a guest walks in. Tying both to
 * the ticket lifecycle means the front desk is never selling a broken room
 * because someone updated a status in one screen and not the other:
 *   raise / re-open  -> room becomes `maintenance` (unless occupied)
 *   resolve          -> room becomes `cleaning`  (unless occupied)
 *   cancel           -> room returns to `available` when no other ticket
 *                       still asks for it
 * `occupied` always wins: a guest reported the leaking tap, and the guest
 * stays. The ticket does not eject them, and checkout flows will mark the
 * room for cleaning anyway.
 *
 * COMMUNICATION
 * Routes -> maintenance.controller.js -> THIS FILE
 *        -> maintenance.repository.js, room.repository.js, webhook.service.js
 * Database tables used: maintenance_tickets, rooms
 */
import ApiError from '../utils/errors.js';
import maintenanceRepository from '../repositories/maintenance.repository.js';
import roomRepository from '../repositories/room.repository.js';
import webhookService from './webhook.service.js';

/** The statuses the table accepts. */
export const TICKET_STATUSES = Object.freeze([
    'open',
    'in_progress',
    'resolved',
    'cancelled',
]);

const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

/**
 * Applies one status change's consequences to the room.
 * Always idempotent and never throws on a missing room: tickets survive a
 * room being retired, so the automation must not crash the board.
 */
async function syncRoomForStatus(roomId, status) {
    if (!roomId) return;

    const room = await roomRepository.findById(roomId).catch(() => null);
    if (!room || room.status === 'occupied') return;

    const done = status === 'resolved' || status === 'cancelled';
    if (done) {
        // Ignore this ticket itself, which by now no longer counts as active.
        const otherTicket = await maintenanceRepository.hasActiveTicket(roomId);
        if (otherTicket) return;

        // A repaired room still needs housekeeping to pass it; a withdrawn
        // ticket releases the room with no such need.
        await roomRepository.updateStatus(roomId, status === 'resolved' ? 'cleaning' : 'available');
        return;
    }

    // raise or re-open: keep the room out of the sellable pool.
    await roomRepository.updateStatus(roomId, 'maintenance');
}

const maintenanceService = {
    /** Raises one ticket. */
    async createTicket({ roomId, title, description, priority, assignedTo }, requester) {
        let room = null;

        if (roomId) {
            room = await roomRepository.findById(Number(roomId));
            if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
        }

        if (!PRIORITIES.includes(priority)) {
            throw ApiError.badRequest('Choose a valid priority', 'INVALID_PRIORITY');
        }

        const id = await maintenanceRepository.create({
            ticketNumber: await maintenanceRepository.generateTicketNumber(),
            roomId: room?.id ?? null,
            title,
            description: description || null,
            priority,
            reportedBy: requester.id,
            assignedTo: assignedTo ?? undefined,
        });

        // A broken room must not be sold from the moment the ticket exists.
        await syncRoomForStatus(room?.id ?? null, 'open');

        const ticket = await this.getTicket(id);

        webhookService.emit('maintenance.ticket_created', {
            ticketNumber: ticket.ticketNumber,
            roomId: ticket.roomId,
            roomNumber: ticket.roomNumber,
            title: ticket.title,
            priority: ticket.priority,
        });

        return ticket;
    },

    async getTicket(id) {
        const ticket = await maintenanceRepository.findById(id);
        if (!ticket) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
        return ticket;
    },

    async listTickets({ page, limit, status, openOnly, priority, roomId, search, sortBy, sortDir }) {
        return maintenanceRepository.findMany({
            page,
            limit,
            status,
            openOnly,
            priority,
            roomId,
            search,
            sortBy,
            sortDir,
        });
    },

    /** Status counts for the board header. */
    async getCounts() {
        return maintenanceRepository.getStatusCounts();
    },

    /**
     * Moves a ticket through its life.
     *
     * Transitions are deliberately generous: rescheduling priority, swapping
     * the assignee and re-opening a ticket are desk decisions, and the data
     * rules that matter (statuses, room status) are enforced here and in the
     * schema rather than as a strict state chart the staff would have to
     * route around.
     */
    async updateTicket(id, input, requester) {
        const ticket = await this.getTicket(id);

        // Assignee is a user id or null. Anything else is the client sending
        // a display name where only an id works.
        const assignedTo = input.assignedTo === undefined
            ? undefined
            : (input.assignedTo === null || input.assignedTo === '' ? null : Number(input.assignedTo));

        let resolvedAt;
        if (input.status && input.status !== ticket.status) {
            if (input.status === 'resolved') {
                if (ticket.status === 'cancelled') {
                    throw ApiError.badRequest('A cancelled ticket cannot be resolved', 'INVALID_TRANSITION');
                }
                resolvedAt = new Date();
            } else if (ticket.status === 'resolved') {
                // Re-opening resolved work is legitimate (it came back).
                resolvedAt = undefined;
            }
        }

        await maintenanceRepository.update(id, {
            title: input.title ?? undefined,
            description: input.description ?? undefined,
            priority: input.priority ?? undefined,
            status: input.status ?? undefined,
            assignedTo,
            // The repository's COALESCE keeps resolved_at once set; re-opening
            // intentionally cannot erase it, because the work did happen.
            resolvedAt,
            resolutionNotes: input.resolutionNotes ?? undefined,
        });

        const updated = await this.getTicket(id);

        // Room automation follows the ticket, not the request: whichever
        // status the ticket now carries decides the room's sellability.
        if (input.status && input.status !== ticket.status) {
            await syncRoomForStatus(ticket.roomId, input.status);

            if (input.status === 'resolved') {
                webhookService.emit('maintenance.ticket_resolved', {
                    ticketNumber: updated.ticketNumber,
                    roomId: updated.roomId,
                    roomNumber: updated.roomNumber,
                    title: updated.title,
                    resolutionNote: updated.resolutionNotes,
                });
            }
        }

        return updated;
    },

    /** Rooms currently out of service because of an open ticket. */
    async findActiveTicketsForRoom(roomId) {
        return maintenanceRepository.findActiveByRoom(roomId);
    },
};

export default maintenanceService;
