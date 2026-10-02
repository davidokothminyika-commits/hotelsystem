/**
 * src/repositories/audit.repository.js
 *
 * WHAT THIS MODULE DOES
 * Writes and reads the `audit_logs` table.
 *
 * WHY IT EXISTS
 * Separating audit SQL from the audit middleware keeps the middleware focused
 * on "when and why to log" and the repository focused on "how to store it".
 *
 * PRIVACY NOTE
 * Audit rows can contain personal data (for example the email used in a failed
 * login). The table stores metadata as JSON so only the fields an event
 * actually needs are captured, rather than dumping entire request bodies.
 *
 * COMMUNICATION
 * Called by: services/audit.service.js.
 * Database tables used: audit_logs, users (for email lookup on failed login).
 */
import { query, queryOne, execute } from '../config/db.js';
import { parseJsonColumn } from '../utils/json.js';
import { resolvePagination } from './base.repository.js';

const auditRepository = {
    /**
     * Inserts one audit row.
     *
     * `metadata` is JSON.stringify'd because mysql2 cannot bind a plain object
     * to a JSON column directly.
     */
    async insert({ userId, action, entity, entityId, ipAddress, userAgent, metadata }) {
        await execute(
            `INSERT INTO audit_logs (user_id, action, entity, entity_id, ip_address, user_agent, metadata)
             VALUES (:userId, :action, :entity, :entityId, :ipAddress, :userAgent, :metadata)`,
            {
                userId: userId ?? null,
                action,
                entity: entity ?? null,
                entityId: entityId ?? null,
                ipAddress: ipAddress ?? null,
                userAgent: userAgent || null,
                metadata: metadata ? JSON.stringify(metadata) : null,
            },
        );
    },

    /**
     * Paginated audit log with filters, used by the admin audit screen.
     */
    async findMany({ page = 1, limit = 50, search, action, userId, startDate, endDate }) {
        const { limit: safeLimit, offset } = resolvePagination({ page, limit });

        const conditions = [];
        const params = {};

        if (search) {
            conditions.push({ sql: '(u.email LIKE :search OR al.action LIKE :search)', params: { search: `%${search}%` } });
        }
        if (action) {
            conditions.push({ sql: 'al.action = :action', params: { action } });
        }
        if (userId) {
            conditions.push({ sql: 'al.user_id = :userId', params: { userId } });
        }
        if (startDate) {
            conditions.push({ sql: 'al.created_at >= :startDate', params: { startDate } });
        }
        if (endDate) {
            conditions.push({ sql: 'al.created_at <= :endDate', params: { endDate } });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const merged = Object.assign({}, ...conditions.map((c) => c.params ?? {}));

        const rows = await query(
            `SELECT al.id, al.user_id, al.action, al.entity, al.entity_id,
                    al.ip_address, al.user_agent, al.metadata, al.created_at,
                    u.email AS user_email,
                    CONCAT(u.first_name, ' ', u.last_name) AS user_name
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             ${where}
             ORDER BY al.created_at DESC, al.id DESC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, merged, { limit: safeLimit, offset }),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id ${where}`,
            merged,
        );

        return {
            rows: rows.map(mapAuditRow),
            total: countRow ? Number(countRow.total) : 0,
            page: Number(page) || 1,
            limit: safeLimit,
        };
    },

    /** Distinct action codes, to populate the filter dropdown. */
    async listActions() {
        const rows = await query(
            'SELECT DISTINCT action FROM audit_logs ORDER BY action ASC',
        );
        return rows.map((row) => row.action);
    },

    /** Recent activity feed for the admin dashboard. */
    async findRecent(limit = 10) {
        const rows = await query(
            `SELECT al.id, al.action, al.entity, al.entity_id, al.created_at,
                    u.email AS user_email
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             ORDER BY al.created_at DESC, al.id DESC
             LIMIT :limit`,
            { limit: Math.min(100, Math.max(1, Number(limit) || 10)) },
        );
        return rows;
    },

    /** Removes entries older than a cutoff. Used by a maintenance job. */
    async deleteOlderThan(cutoffDate) {
        const result = await execute('DELETE FROM audit_logs WHERE created_at < :cutoffDate', { cutoffDate });
        return result.affectedRows;
    },
};

function mapAuditRow(row) {
    // Shared helper: mysql2 may return a JSON column already parsed or as a
    // string, and parsing an already-parsed value would throw.
    const metadata = parseJsonColumn(row.metadata, null);
    return {
        id: row.id,
        userId: row.user_id,
        userEmail: row.user_email,
        userName: row.user_name,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        metadata,
        createdAt: row.created_at,
    };
}

export default auditRepository;