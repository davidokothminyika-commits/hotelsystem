/**
 * src/repositories/user.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for the `users` table. Nothing else in the application writes SQL
 * against users.
 *
 * WHY IT EXISTS
 * Keeping SQL here means:
 *   - the table's columns are documented in exactly one file,
 *   - the password_hash column can never be forgotten in a SELECT,
 *   - controllers and services stay free of SQL strings.
 *
 * SECURITY NOTE ON PASSWORD_HASH
 * Only `findByEmailWithPassword` selects the hash. Every other read uses
 * `USER_COLUMNS`, which omits it entirely. This makes leaking the hash an
 * explicit, greppable decision rather than an accident.
 *
 * COMMUNICATION
 * Called by: services/auth.service.js, services/user.service.js,
 *            services/admin.service.js, middleware/auth.middleware.js.
 * Database tables used: users, roles.
 * Frontend access: through /api/auth/* and /api/users/* endpoints.
 */
import { query, queryOne, execute } from '../config/db.js';

/** Columns safe to return to a client. Deliberately excludes password_hash. */
export const USER_COLUMNS = `
    u.id,
    u.first_name,
    u.last_name,
    u.email,
    u.phone,
    u.profile_image,
    u.is_active,
    u.email_verified,
    u.email_verified_at,
    u.last_login_at,
    u.created_at,
    u.updated_at,
    u.role_id,
    r.name AS role
`;

/** Shape returned to the frontend, with snake_case converted to camelCase. */
export function mapUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: `${row.first_name} ${row.last_name}`.trim(),
        email: row.email,
        phone: row.phone,
        profileImage: row.profile_image,
        isActive: Boolean(row.is_active),
        emailVerified: Boolean(row.email_verified),
        emailVerifiedAt: row.email_verified_at,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        role: row.role,
    };
}

const userRepository = {
    /**
     * Finds a user by id. Used by the auth middleware on every request.
     */
    async findById(id) {
        const row = await queryOne(
            `SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id`,
            { id },
        );
        return mapUser(row);
    },

    /**
     * Finds a user by email, case insensitively.
     * The users table uses a case insensitive collation, so `=` already matches
     * case insensitively; lower() is kept for clarity and index friendliness.
     */
    async findByEmail(email) {
        const row = await queryOne(
            `SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = :email`,
            { email },
        );
        return mapUser(row);
    },

    /**
     * Finds a user by email INCLUDING the password hash.
     * Only the login flow may call this.
     */
    async findByEmailWithPassword(email) {
        return queryOne(
            `SELECT u.*, r.name AS role
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE u.email = :email`,
            { email },
        );
    },

    /**
     * Finds a user by id INCLUDING the password hash.
     * Needed by the change-password flow, which must compare the current
     * password before allowing a new one.
     */
    async findByIdWithPassword(id) {
        return queryOne(
            `SELECT u.*, r.name AS role
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE u.id = :id`,
            { id },
        );
    },

    /** Returns just the id for a given email. Used when auditing failed logins. */
    async findIdByEmail(email) {
        const row = await queryOne('SELECT id FROM users WHERE email = :email', { email });
        return row ? row.id : null;
    },

    /** True when the email is already registered. Used to avoid duplicate signups. */
    async emailExists(email) {
        const row = await queryOne('SELECT id FROM users WHERE email = :email LIMIT 1', { email });
        return Boolean(row);
    },

    /**
     * Creates a user. `role_id` is resolved from the roles table by the
     * service, never accepted straight from the request body.
     */
    async create({ firstName, lastName, email, phone, passwordHash, roleId, emailVerified = false }) {
        const result = await execute(
            `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, email_verified)
             VALUES (:roleId, :firstName, :lastName, :email, :phone, :passwordHash, :emailVerified)`,
            {
                roleId,
                firstName,
                lastName,
                email,
                phone: phone || null,
                passwordHash,
                emailVerified: emailVerified ? 1 : 0,
            },
        );
        return result.insertId;
    },

    /** Updates the editable profile fields. */
    async updateProfile(id, { firstName, lastName, phone }) {
        await execute(
            `UPDATE users
             SET first_name = :firstName, last_name = :lastName, phone = :phone
             WHERE id = :id`,
            { id, firstName, lastName, phone: phone || null },
        );
        return this.findById(id);
    },

    async updatePassword(id, passwordHash) {
        await execute('UPDATE users SET password_hash = :passwordHash WHERE id = :id', { id, passwordHash });
    },

    async updateProfileImage(id, profileImage) {
        await execute('UPDATE users SET profile_image = :profileImage WHERE id = :id', { id, profileImage });
    },

    async updateLastLogin(id) {
        await execute('UPDATE users SET last_login_at = NOW() WHERE id = :id', { id });
    },

    async markEmailVerified(id) {
        await execute(
            'UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = :id',
            { id },
        );
    },

    /** Clears the verified flag, used when an account changes its email. */
    async clearEmailVerification(id) {
        await execute('UPDATE users SET email_verified = 0, email_verified_at = NULL WHERE id = :id', { id });
    },

    /**
     * Changes the email address. The service layer is responsible for
     * verifying the password and clearing the verified flag first, since that
     * is a rule rather than a data operation.
     */
    async updateEmail(id, email) {
        await execute('UPDATE users SET email = :email WHERE id = :id', { id, email });
    },

    async setActive(id, isActive) {
        await execute('UPDATE users SET is_active = :isActive WHERE id = :id', {
            id,
            isActive: isActive ? 1 : 0,
        });
        return this.findById(id);
    },

    async updateRole(id, roleId) {
        await execute('UPDATE users SET role_id = :roleId WHERE id = :id', { id, roleId });
        return this.findById(id);
    },

    async delete(id) {
        const result = await execute('DELETE FROM users WHERE id = :id', { id });
        return result.affectedRows > 0;
    },

    /**
     * Paginated listing with search and role filtering, used by the admin
     * users table.
     *
     * SEARCH IS PARAMETERISED: the LIKE pattern is a bound value. The
     * wildcards are part of the value, not the SQL text.
     */
    async findMany({ page, limit, offset, search, role, isActive }) {
        const conditions = [];
        const params = { limit, offset };

        if (search) {
            conditions.push({
                sql: '(u.first_name LIKE :search OR u.last_name LIKE :search OR u.email LIKE :search)',
                params: { search: `%${search}%` },
            });
        }
        if (role) {
            conditions.push({ sql: 'r.name = :role', params: { role } });
        }
        if (isActive !== undefined && isActive !== null && isActive !== '') {
            conditions.push({ sql: 'u.is_active = :isActive', params: { isActive: Number(isActive) } });
        }

        const whereClause = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const mergedParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}), params);

        const rows = await query(
            `SELECT ${USER_COLUMNS}
             FROM users u JOIN roles r ON r.id = u.role_id
             ${whereClause}
             ORDER BY u.created_at DESC
             LIMIT :limit OFFSET :offset`,
            mergedParams,
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${whereClause}`,
            Object.assign({}, ...conditions.map((c) => c.params ?? {})),
        );

        return {
            rows: rows.map(mapUser),
            total: countRow ? Number(countRow.total) : 0,
        };
    },

    /**
     * Aggregated counts for the admin dashboard.
     * Returns counts grouped by role so the UI can render a breakdown.
     */
    async getStats() {
        const byRole = await query(
            `SELECT r.name AS role, COUNT(u.id) AS total,
                    SUM(CASE WHEN u.is_active = 1 THEN 1 ELSE 0 END) AS active
             FROM roles r LEFT JOIN users u ON u.role_id = r.id
             GROUP BY r.id, r.name
             ORDER BY total DESC`,
        );

        const totalRow = await queryOne(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified
             FROM users`,
        );

        const guestRow = await queryOne(
            `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'guest'`,
        );

        return {
            total: Number(totalRow?.total || 0),
            active: Number(totalRow?.active || 0),
            verified: Number(totalRow?.verified || 0),
            guests: Number(guestRow?.total || 0),
            byRole: byRole.map((row) => ({
                role: row.role,
                total: Number(row.total),
                active: Number(row.active || 0),
            })),
        };
    },

    /**
     * Counts users created per day, for the admin analytics chart.
     */
    async countRegistrationsOverDays(days = 30) {
        return query(
            `SELECT DATE(created_at) AS day, COUNT(*) AS total
             FROM users
             WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
             GROUP BY DATE(created_at)
             ORDER BY day ASC`,
            { days },
        );
    },
};

export default userRepository;