/**
 * src/repositories/maintenance.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for repair work orders (maintenance_tickets).
 *
 * WHY room_name AND ACTOR NAMES ARE JOINED HERE
 * The board a housekeeping team works from shows "Room 204 - leaking tap,
 * assigned to David". Those are display concerns of this resource, so the
 * joins live beside the table they serve.
 *
 * COMMUNICATION
 * Called by: services/maintenance.service.js
 * Database tables used: maintenance_tickets, rooms, users
 * Frontend: /api/maintenance
 */
import { query, queryOne, execute } from '../config/db.js';

const TICKET_SELECT = `
    SELECT m.*,
           r.room_number,
           rt.name AS room_type,
           CONCAT(rep.first_name, ' ', rep.last_name) AS reported_by_name,
           rep.email AS reported_by_email,
           CONCAT(asg.first_name, ' ', asg.last_name) AS assigned_to_name,
           asg.email AS assigned_to_email
    FROM maintenance_tickets m
    LEFT JOIN rooms r ON r.id = m.room_id
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN users rep ON rep.id = m.reported_by
    LEFT JOIN users asg ON asg.id = m.assigned_to`;

function mapTicket(row) {
    if (!row) return null;
    return {
        id: row.id,
        ticketNumber: row.ticket_number,
        roomId: row.room_id ?? null,
        roomNumber: row.room_number ?? null,
        roomType: row.room_type ?? null,
        title: row.title,
        description: row.description,
        priority: row.priority,
        status: row.status,
        reportedBy: row.reported_by ?? null,
        reportedByName: row.reported_by_name ?? null,
        reportedByEmail: row.reported_by_email ?? null,
        assignedTo: row.assigned_to ?? null,
        assignedToName: row.assigned_to_name ?? null,
        assignedToEmail: row.assigned_to_email ?? null,
        resolvedAt: row.resolved_at,
        resolutionNotes: row.resolution_notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const maintenanceRepository = {
    /**
     * Generates a unique ticket number.
     * Format: 'MT' + base36 timestamp + random, filling CHAR(10) exactly.
     * Same scheme as booking references, so every ticket is both greppable and
     * roughly sortable by when it was raised.
     */
    async generateTicketNumber() {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const timestamp = Date.now().toString(36).toUpperCase().padStart(6, '0').slice(-5);
            let random = '';
            for (let i = 0; i < 3; i += 1) {
                random += alphabet[Math.floor(Math.random() * alphabet.length)];
            }

            const number = `MT${timestamp}${random}`;
            const existing = await queryOne(
                'SELECT id FROM maintenance_tickets WHERE ticket_number = :number',
                { number },
            );
            if (!existing) return number;
        }

        throw new Error('Unable to generate a unique ticket number');
    },

    async create({ ticketNumber, roomId, title, description, priority, reportedBy, assignedTo }) {
        const result = await execute(
            `INSERT INTO maintenance_tickets
                (ticket_number, room_id, title, description, priority, reported_by, assigned_to)
             VALUES
                (:ticketNumber, :roomId, :title, :description, :priority, :reportedBy, :assignedTo)`,
            {
                ticketNumber,
                roomId: roomId || null,
                title,
                description: description || null,
                priority: priority || 'normal',
                reportedBy: reportedBy || null,
                assignedTo: assignedTo || null,
            },
        );
        return result.insertId;
    },

    async findById(id) {
        const row = await queryOne(`${TICKET_SELECT} WHERE m.id = :id`, { id });
        return mapTicket(row);
    },

    /**
     * Paginated ticket list.
     * `openOnly` collapses open + in_progress, which is how the boards are
     * actually used ("what is still to do"); resolved work moves behind the
     * status filter instead.
     */
    async findMany({ page = 1, limit = 20, status, openOnly, priority, roomId, search, sortBy, sortDir }) {
        const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
        const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
        const params = { limit: safeLimit, offset: (safePage - 1) * safeLimit };

        const conditions = [];
        if (openOnly) {
            conditions.push({ sql: 'm.status IN (:openStatus1, :openStatus2)', params: { openStatus1: 'open', openStatus2: 'in_progress' } });
        } else if (status) {
            const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, index) => `:status${index}`).join(', ');
                conditions.push({
                    sql: `m.status IN (${placeholders})`,
                    params: Object.fromEntries(statuses.map((value, index) => [`status${index}`, value])),
                });
            }
        }
        if (priority) {
            const priorities = String(priority).split(',').map((value) => value.trim()).filter(Boolean);
            if (priorities.length > 0) {
                const placeholders = priorities.map((_, index) => `:prio${index}`).join(', ');
                conditions.push({
                    sql: `m.priority IN (${placeholders})`,
                    params: Object.fromEntries(priorities.map((value, index) => [`prio${index}`, value])),
                });
            }
        }
        if (roomId) {
            conditions.push({ sql: 'm.room_id = :roomId', params: { roomId } });
        }
        if (search) {
            conditions.push({
                sql: '(m.ticket_number LIKE :search OR m.title LIKE :search OR r.room_number LIKE :search)',
                params: { search: `%${search}%` },
            });
        }

        const where = conditions.length
            ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}`
            : '';
        const filterParams = Object.assign(...conditions.map((c) => c.params ?? {}), {});

        // Urgent first, then by age the front desk last touched it.
        const sortColumn = allowedSort(sortBy) || 'FIELD(m.status, \'open\', \'in_progress\', \'resolved\', \'cancelled\'), FIELD(m.priority, \'urgent\', \'high\', \'normal\', \'low\'), m.created_at';
        const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';

        const rows = await query(
            `${TICKET_SELECT}
             ${where}
             ORDER BY ${sortColumn} ${sortDirection}, m.id ASC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM maintenance_tickets m
             LEFT JOIN rooms r ON r.id = m.room_id
             ${where}`,
            filterParams,
        );

        return {
            rows: rows.map(mapTicket),
            total: countRow ? Number(countRow.total) : 0,
            page: safePage,
            limit: safeLimit,
        };
    },

    /**
     * Updates the mutable fields of a ticket.
     * Each COALESCE keeps untouched fields exactly as they were, which is what
     * makes PATCH safe to call with only the status change.
     */
    async update(id, { title, description, priority, status, assignedTo, resolutionNotes, resolvedAt }) {
        await execute(
            `UPDATE maintenance_tickets SET
                title = COALESCE(:title, title),
                description = COALESCE(:description, description),
                priority = COALESCE(:priority, priority),
                status = COALESCE(:status, status),
                assigned_to = :assignedTo,
                resolved_at = COALESCE(resolved_at, :resolvedAt),
                resolution_notes = COALESCE(:resolutionNotes, resolution_notes)
             WHERE id = :id`,
            {
                id,
                title: title ?? null,
                description: description ?? null,
                priority: priority ?? null,
                status: status ?? null,
                // An explicit null un-assigns; a missing field keeps the existing
                // assignment, so this must not be COALESCE.
                assignedTo: assignedTo === undefined ? null : assignedTo,
                resolvedAt: resolvedAt || null,
                resolutionNotes: resolutionNotes ?? null,
            },
        );
    },

    /** Counts for the board header and the dashboards. */
    async getStatusCounts() {
        const rows = await query(
            `SELECT status, COUNT(*) AS total FROM maintenance_tickets GROUP BY status`,
        );
        const counts = { open: 0, in_progress: 0, resolved: 0, cancelled: 0 };
        for (const row of rows) counts[row.status] = Number(row.total);
        return counts;
    },

    /**
     * Whether a room still has an unresolved ticket.
     * Used when releasing a room after a repair: the room's cleaning flag
     * belongs to the last ticket, not to this one.
     */
    async hasActiveTicket(roomId) {
        const row = await queryOne(
            `SELECT COUNT(*) AS total FROM maintenance_tickets
             WHERE room_id = :roomId AND status IN ('open', 'in_progress')`,
            { roomId },
        );
        return Number(row.total) > 0;
    },

    /** Tickets that are still to do, on any room, oldest first. */
    async findActiveByRoom(roomId) {
        const rows = await query(
            `${TICKET_SELECT} WHERE m.room_id = :roomId AND m.status IN ('open', 'in_progress')
             ORDER BY m.created_at ASC`,
            { roomId },
        );
        return rows.map(mapTicket);
    },
};

/** Allow list for external sorting; anything else falls back to the default. */
function allowedSort(sortBy) {
    switch (sortBy) {
        case 'm.created_at':
        case 'm.priority':
        case 'm.status':
        case 'r.room_number':
            return sortBy;
        default:
            return null;
    }
}

export default maintenanceRepository;
