/**
 * src/repositories/admin.repository.js
 *
 * WHAT THIS MODULE DOES
 * Administrative queries that span several tables: user management listings,
 * role assignment and system-wide statistics.
 *
 * WHY IT EXISTS
 * These queries are read-only aggregations and joins that belong to no single
 * entity. Putting them in their own repository keeps the entity
 * repositories focused and makes the admin surface easy to review.
 *
 * COMMUNICATION
 * Called by: services/admin.service.js
 * Database tables used: users, roles, bookings, orders, payments, rooms.
 */
import { query, queryOne } from '../config/db.js';

const adminRepository = {
    /**
     * Extended user listing including booking counts and total spend, so the
     * admin table can show value per customer without an N+1 query per row.
     */
    async listUsers({ limit, offset, search, role, isActive, sortBy, sortDir }) {
        const conditions = [];
        const params = { limit, offset };

        if (search) {
            conditions.push({
                sql: '(u.first_name LIKE :search OR u.last_name LIKE :search OR u.email LIKE :search)',
                params: { search: `%${search}%` },
            });
        }
        if (role) conditions.push({ sql: 'r.name = :role', params: { role } });
        if (isActive !== undefined && isActive !== null && isActive !== '') {
            conditions.push({ sql: 'u.is_active = :isActive', params: { isActive: Number(isActive) } });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));

        const rows = await query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.is_active,
                    u.email_verified, u.created_at, u.last_login_at, u.profile_image,
                    r.name AS role,
                    COUNT(DISTINCT b.id) AS booking_count,
                    COALESCE(SUM(DISTINCT p.amount), 0) AS total_spent
             FROM users u
             JOIN roles r ON r.id = u.role_id
             LEFT JOIN bookings b ON b.user_id = u.id AND b.status NOT IN ('cancelled')
             LEFT JOIN payments p ON p.user_id = u.id AND p.status = 'completed'
             ${where}
             GROUP BY u.id
             ORDER BY ${sortBy} ${sortDir}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${where}`,
            filterParams,
        );

        return { rows, total: countRow ? Number(countRow.total) : 0 };
    },

    /**
     * Single user with full detail, including their activity summary.
     */
    async findUserDetail(id) {
        return queryOne(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.is_active,
                    u.email_verified, u.created_at, u.last_login_at, u.profile_image,
                    r.name AS role,
                    (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS booking_count,
                    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
                    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                      WHERE p.user_id = u.id AND p.status = 'completed') AS total_spent
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE u.id = :id`,
            { id },
        );
    },

    /**
     * Recent security-relevant activity for the admin dashboard feed.
     */
    async recentActivity(limit = 15) {
        return query(
            `SELECT al.id, al.action, al.entity, al.entity_id, al.created_at, al.ip_address,
                    u.email AS user_email, CONCAT(u.first_name, ' ', u.last_name) AS user_name
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             ORDER BY al.created_at DESC, al.id DESC
             LIMIT :limit`,
            { limit: Math.min(100, Math.max(1, Number(limit) || 15)) },
        );
    },

    /** Counts of users per role, for the roles screen. */
    async roleUserCounts() {
        return query(
            `SELECT r.id, r.name, r.description,
                    (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
             FROM roles r ORDER BY r.id ASC`,
        );
    },
};

export default adminRepository;