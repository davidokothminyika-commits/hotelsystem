/**
 * src/repositories/permission.repository.js
 *
 * WHAT THIS MODULE DOES
 * Reads the roles, permissions and their mapping.
 *
 * WHY IT EXISTS
 * Authorization decisions must be driven by data, not by hard coded strings
 * spread through the codebase. Roles and permissions live in the database so
 * an administrator can adjust access without a code change or redeploy.
 *
 * COMMUNICATION
 * Called by: middleware/authorization.middleware.js, services/auth.service.js.
 * Database tables used: roles, permissions, role_permissions, users.
 */
import { query, queryOne, execute } from '../config/db.js';
import { buildInClause } from './base.repository.js';

/** Permission codes defined by the seed, grouped for readability in the UI. */
export const PERMISSION_CATALOG = Object.freeze({
    'booking:create': 'Create a booking',
    'booking:read': 'View bookings',
    'booking:update': 'Update or confirm bookings',
    'booking:cancel': 'Cancel bookings',
    'booking:checkin': 'Check guests in and out',
    'room:read': 'View rooms',
    'room:create': 'Create rooms',
    'room:update': 'Update rooms',
    'room:delete': 'Delete rooms',
    'room:status': 'Change room status',
    'order:create': 'Place food orders',
    'order:read': 'View food orders',
    'order:update': 'Update order status',
    'menu:read': 'View the menu',
    'menu:write': 'Create and edit menu items',
    'payment:create': 'Make a payment',
    'payment:read': 'View payments',
    'payment:refund': 'Refund payments',
    'invoice:read': 'View invoices',
    'review:create': 'Write reviews',
    'review:moderate': 'Hide or restore reviews',
    'chat:send': 'Send messages',
    'chat:reply': 'Answer guest messages',
    'user:read': 'View users',
    'user:write': 'Create and update users',
    'user:delete': 'Delete users',
    'role:write': 'Manage roles and permissions',
    'report:read': 'View reports',
    'audit:read': 'View audit logs',
    'setting:write': 'Change system settings',
});

/**
 * The role -> permission mapping that authorization middleware consults.
 * Returned shape: { admin: Set(['booking:create', ...]), guest: Set([...]) }
 */
let cachedMap = null;

const permissionRepository = {
    /**
     * Loads every role with the permission codes it grants.
     */
    async getRolePermissionMap() {
        const rows = await query(
            `SELECT r.name AS role, p.code AS permission
             FROM roles r
             LEFT JOIN role_permissions rp ON rp.role_id = r.id
             LEFT JOIN permissions p ON p.id = rp.permission_id`,
        );

        const map = {};
        for (const row of rows) {
            if (!map[row.role]) map[row.role] = new Set();
            if (row.permission) map[row.role].add(row.permission);
        }

        cachedMap = map;
        return map;
    },

    /** Cached accessor used by the authorization middleware. */
    async getCachedMap() {
        if (cachedMap) return cachedMap;
        return this.getRolePermissionMap();
    },

    /** Called after roles or permissions change so the cache cannot go stale. */
    invalidateCache() {
        cachedMap = null;
    },

    async findRoleIdByName(name) {
        const row = await queryOne('SELECT id, name FROM roles WHERE name = :name', { name });
        return row ? row.id : null;
    },

    async listRoles() {
        const rows = await query(
            `SELECT r.id, r.name, r.description,
                    (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count,
                    (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
             FROM roles r ORDER BY r.id ASC`,
        );
        return rows;
    },

    async listPermissions() {
        return query('SELECT id, code, description FROM permissions ORDER BY code ASC');
    },

    async listRolesWithPermissions() {
        const roles = await this.listRoles();
        const grants = await query(
            `SELECT r.name AS role, p.code AS permission
             FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id
             JOIN permissions p ON p.id = rp.permission_id`,
        );

        const grouped = {};
        for (const row of grants) {
            if (!grouped[row.role]) grouped[row.role] = [];
            grouped[row.role].push(row.permission);
        }

        return roles.map((role) => ({ ...role, permissions: grouped[role.name] || [] }));
    },

    async roleExists(name) {
        const row = await queryOne('SELECT id FROM roles WHERE name = :name', { name });
        return Boolean(row);
    },

    async createRole({ name, description }) {
        const result = await execute('INSERT INTO roles (name, description) VALUES (:name, :description)', {
            name,
            description: description || null,
        });
        this.invalidateCache();
        return result.insertId;
    },

    async updateRole(id, { name, description }) {
        await execute('UPDATE roles SET name = :name, description = :description WHERE id = :id', {
            id,
            name,
            description: description || null,
        });
        this.invalidateCache();
    },

    async deleteRole(id) {
        const result = await execute('DELETE FROM roles WHERE id = :id', { id });
        this.invalidateCache();
        return result.affectedRows > 0;
    },

    /**
     * Replaces a role's permission set.
     *
     * Runs in a transaction: the old grants are deleted and the new ones
     * inserted together, so a failure can never leave a role with no
     * permissions at all (which would silently lock staff out).
     */
    async setRolePermissions(roleId, permissionCodes) {
        // Placeholders are generated from the count; the codes themselves are
        // still bound parameters, so an unknown code can never reach the SQL.
        const { placeholders, params } = buildInClause(permissionCodes, 'code');

        const permissions = permissionCodes.length
            ? await query(`SELECT id, code FROM permissions WHERE code IN (${placeholders})`, params)
            : [];

        const found = permissions.map((p) => p.code);
        const missing = permissionCodes.filter((code) => !found.includes(code));
        if (missing.length > 0) {
            return { ok: false, missing };
        }

        await execute('DELETE FROM role_permissions WHERE role_id = :roleId', { roleId });
        for (const permission of permissions) {
            await execute(
                'INSERT INTO role_permissions (role_id, permission_id) VALUES (:roleId, :permissionId)',
                { roleId, permissionId: permission.id },
            );
        }

        this.invalidateCache();
        return { ok: true };
    },
};

export default permissionRepository;