/**
 * src/services/admin.service.js
 *
 * WHAT THIS MODULE DOES
 * Administrator-only operations: managing user accounts, assigning roles and
 * reviewing system activity.
 *
 * WHY IT EXISTS
 * These actions are powerful, so they are grouped in one service where the
 * safety rules are visible together. The most important rule is the
 * self-protection rule described in `updateUserStatus` and `deleteUser`.
 *
 * COMMUNICATION
 * Browser -> /api/admin/* -> admin.controller.js -> THIS FILE
 *        -> admin.repository.js, user.repository.js, permission.repository.js
 * Database tables used: users, roles, permissions, role_permissions, audit_logs.
 */
import bcrypt from 'bcryptjs';
import ApiError from '../utils/errors.js';
import { queryOne } from '../config/db.js';
import adminRepository from '../repositories/admin.repository.js';
import userRepository from '../repositories/user.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import { resolveSort, resolvePagination } from '../repositories/base.repository.js';
import { signAccessToken } from '../utils/tokens.js';

/** Roles the application relies on, which may never be edited or removed. */
const PROTECTED_ROLES = ['guest', 'admin'];

/** Columns a user listing is allowed to sort by. Prevents ORDER BY injection. */
const SORTABLE_USER_COLUMNS = [
    'u.created_at', 'u.last_name', 'u.first_name', 'u.email',
    'r.name', 'u.last_login_at', 'u.is_active',
];

const adminService = {
    /**
     * Paginated user listing.
     * The sort column is validated against an allow list because ORDER BY
     * cannot take a bound parameter.
     */
    async listUsers({ page = 1, limit = 20, search, role, isActive, sortBy, sortDir }) {
        const pagination = resolvePagination({ page, limit });
        const sort = resolveSort(sortBy, sortDir, SORTABLE_USER_COLUMNS, 'u.created_at');

        const { rows, total } = await adminRepository.listUsers({
            limit: pagination.limit,
            offset: pagination.offset,
            search,
            role,
            isActive,
            sortBy: sort.column,
            sortDir: sort.direction,
        });

        return {
            rows: rows.map((row) => ({
                id: row.id,
                firstName: row.first_name,
                lastName: row.last_name,
                fullName: `${row.first_name} ${row.last_name}`.trim(),
                email: row.email,
                phone: row.phone,
                role: row.role,
                isActive: Boolean(row.is_active),
                emailVerified: Boolean(row.email_verified),
                profileImage: row.profile_image,
                bookingCount: Number(row.booking_count || 0),
                totalSpent: Number(row.total_spent || 0),
                lastLoginAt: row.last_login_at,
                createdAt: row.created_at,
            })),
            total,
            page: pagination.page,
            limit: pagination.limit,
        };
    },

    /** Detailed single user view. */
    async getUser(id) {
        const row = await adminRepository.findUserDetail(id);
        if (!row) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

        return {
            id: row.id,
            firstName: row.first_name,
            lastName: row.last_name,
            fullName: `${row.first_name} ${row.last_name}`.trim(),
            email: row.email,
            phone: row.phone,
            role: row.role,
            isActive: Boolean(row.is_active),
            emailVerified: Boolean(row.email_verified),
            profileImage: row.profile_image,
            bookingCount: Number(row.booking_count || 0),
            orderCount: Number(row.order_count || 0),
            totalSpent: Number(row.total_spent || 0),
            lastLoginAt: row.last_login_at,
            createdAt: row.created_at,
        };
    },

    /**
     * Creates a staff account.
     *
     * Only an administrator may call this. The role is looked up from the
     * roles table by name, so an invalid role fails loudly rather than
     * creating an account with no permissions.
     */
    async createUser({ firstName, lastName, email, phone, password, role }) {
        const normalisedEmail = email.trim().toLowerCase();

        if (await userRepository.emailExists(normalisedEmail)) {
            throw ApiError.conflict('An account with that email already exists', 'EMAIL_ALREADY_REGISTERED');
        }

        const roleId = await permissionRepository.findRoleIdByName(role);
        if (!roleId) {
            throw ApiError.badRequest(`Unknown role "${role}"`, 'INVALID_ROLE');
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const userId = await userRepository.create({
            firstName,
            lastName,
            email: normalisedEmail,
            phone,
            passwordHash,
            roleId,
            emailVerified: true, // staff accounts are verified by the admin who created them
        });

        return this.getUser(userId);
    },

    /**
     * Updates a user's role, active flag or contact details.
     *
     * SELF-PROTECTION RULE
     * An administrator cannot deactivate, demote or delete their own account.
     * Without this rule a single mistake (or a malicious admin) could leave
     * the hotel with no way back in: the last admin would be locked out of the
     * only panel that can restore permissions.
     */
    async updateUser(id, { firstName, lastName, phone, role, isActive }, actingAdminId) {
        const target = await userRepository.findById(id);
        if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

        const isSelf = Number(id) === Number(actingAdminId);

        if (isSelf) {
            if (isActive === false) {
                throw ApiError.badRequest('You cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
            }
            if (role && role !== target.role) {
                throw ApiError.badRequest('You cannot change your own role', 'CANNOT_CHANGE_OWN_ROLE');
            }
        }

        if (isActive !== undefined && isActive !== null && isActive !== '') {
            const nextActive = Boolean(Number(isActive));
            if (!nextActive && target.role === 'admin') {
                const remaining = await this.countActiveAdmins();
                if (remaining <= 1) {
                    throw ApiError.badRequest(
                        'This is the last active administrator. Promote another admin first.',
                        'LAST_ADMIN',
                    );
                }
            }
            await userRepository.setActive(id, nextActive);
        }

        if (role) {
            const roleId = await permissionRepository.findRoleIdByName(role);
            if (!roleId) throw ApiError.badRequest(`Unknown role "${role}"`, 'INVALID_ROLE');
            await userRepository.updateRole(id, roleId);
        }

        if (firstName || lastName || phone !== undefined) {
            await userRepository.updateProfile(id, {
                firstName: firstName || target.firstName,
                lastName: lastName || target.lastName,
                phone: phone === undefined ? target.phone : phone,
            });
        }

        return this.getUser(id);
    },

    /** Deletes a user account. */
    async deleteUser(id, actingAdminId) {
        if (Number(id) === Number(actingAdminId)) {
            throw ApiError.badRequest('You cannot delete your own account', 'CANNOT_DELETE_SELF');
        }

        const target = await userRepository.findById(id);
        if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

        if (target.role === 'admin') {
            const remaining = await this.countActiveAdmins();
            if (remaining <= 1) {
                throw ApiError.badRequest(
                    'This is the last administrator account and cannot be deleted.',
                    'LAST_ADMIN',
                );
            }
        }

        // The foreign keys use ON DELETE RESTRICT, so a user with booking
        // history is protected by the database. The error is translated into
        // a clear message by the error middleware.
        return userRepository.delete(id);
    },

    /**
     * Administrator password reset.
     *
     * This does not require the target's current password, because an admin
     * may need to restore access when a staff member is locked out. The
     * action is audited, which is the appropriate control here.
     */
    async resetUserPassword(id, newPassword) {
        const target = await userRepository.findById(id);
        if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

        await userRepository.updatePassword(id, await bcrypt.hash(newPassword, 12));

        // Any outstanding reset links for that account become invalid.
        const { default: tokenRepository } = await import('../repositories/token.repository.js');
        await tokenRepository.invalidateAllPasswordResets(id);

        return { reset: true };
    },

    /**
     * Number of active administrator accounts.
     * Used by the last-admin safeguards in updateUser and deleteUser.
     */
    async countActiveAdmins() {
        const row = await queryOne(
            `SELECT COUNT(*) AS total
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE r.name = 'admin' AND u.is_active = 1`,
        );
        return row ? Number(row.total) : 0;
    },

    /** Roles with their permission lists, for the roles screen. */
    async listRolesWithPermissions() {
        const roles = await permissionRepository.listRolesWithPermissions();
        const userCounts = await adminRepository.roleUserCounts();
        const countsById = Object.fromEntries(userCounts.map((row) => [row.id, Number(row.user_count)]));

        return roles.map((role) => ({
            id: role.id,
            name: role.name,
            description: role.description,
            userCount: countsById[role.id] || 0,
            permissionCount: Number(role.permission_count || 0),
            permissions: role.permissions,
            isProtected: PROTECTED_ROLES.includes(role.name),
        }));
    },

    /** Replaces a role's permission set. */
    async setRolePermissions(roleId, permissionCodes) {
        const roles = await permissionRepository.listRoles();
        const role = roles.find((item) => String(item.id) === String(roleId));

        if (!role) throw ApiError.notFound('Role not found', 'ROLE_NOT_FOUND');

        // The guest role must keep booking permission, otherwise guests could
        // never use the system at all.
        if (role.name === 'guest' && permissionCodes.length === 0) {
            throw ApiError.badRequest('The guest role must keep at least one permission', 'ROLE_MUST_KEEP_PERMISSIONS');
        }

        const result = await permissionRepository.setRolePermissions(roleId, permissionCodes);

        if (!result.ok) {
            throw ApiError.badRequest(`Unknown permission codes: ${result.missing.join(', ')}`, 'INVALID_PERMISSION');
        }

        return this.listRolesWithPermissions();
    },

    /** All permissions grouped for the role editor UI. */
    async listPermissions() {
        const permissions = await permissionRepository.listPermissions();
        return permissions.map((item) => ({ code: item.code, description: item.description }));
    },

    /** Recent audit activity for the dashboard. */
    async recentActivity(limit) {
        return adminRepository.recentActivity(limit);
    },

    /**
     * Issues a fresh session token for a user after an admin changes their
     * role or status, so their next request is evaluated against fresh data
     * rather than a stale token payload.
     */
    issueSessionFor(user) {
        return signAccessToken({ id: user.id, role: user.role, email: user.email });
    },
};

export default adminService;