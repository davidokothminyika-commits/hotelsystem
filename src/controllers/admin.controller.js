/**
 * src/controllers/admin.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for administrator-only operations.
 *
 * WHY IT EXISTS
 * Isolates the admin surface so it can be reviewed and permissioned as one
 * unit. Every route that uses this controller is protected by requireRole or
 * requireStaff in the route file; the controller trusts that chain rather
 * than re-checking roles.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/admin.service.js -> repositories -> MySQL
 * Frontend calls: public/js/api/admin.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import adminService from '../services/admin.service.js';

const adminController = {
    // -------------------------------------------------------------------------
    // Users
    // -------------------------------------------------------------------------

    /** GET /api/admin/users */
    listUsers: asyncHandler(async (req, res) => {
        const query = req.query;
        const result = await adminService.listUsers({
            page: query.page,
            limit: query.limit,
            search: query.search,
            role: query.role,
            isActive: query.isActive,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        return sendPaginated(res, result.rows, { page: result.page, limit: result.limit, total: result.total }, 'Users retrieved');
    }),

    /** GET /api/admin/users/:id */
    getUser: asyncHandler(async (req, res) => {
        const user = await adminService.getUser(req.params.id);
        return sendSuccess(res, 'User retrieved', { user });
    }),

    /** POST /api/admin/users */
    createUser: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const user = await adminService.createUser(payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.USER_CREATED,
            entity: 'users',
            entityId: user.id,
            req,
            metadata: { email: user.email, role: user.role },
        });

        return sendCreated(res, 'User created successfully', { user });
    }),

    /** PATCH /api/admin/users/:id */
    updateUser: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const user = await adminService.updateUser(req.params.id, payload, req.user.id);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.USER_UPDATED,
            entity: 'users',
            entityId: user.id,
            req,
            metadata: { changes: Object.keys(payload) },
        });

        return sendSuccess(res, 'User updated successfully', { user });
    }),

    /** DELETE /api/admin/users/:id */
    deleteUser: asyncHandler(async (req, res) => {
        await adminService.deleteUser(req.params.id, req.user.id);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.USER_DELETED,
            entity: 'users',
            entityId: req.params.id,
            req,
        });

        return sendSuccess(res, 'User deleted successfully');
    }),

    /** POST /api/admin/users/:id/reset-password */
    resetUserPassword: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        await adminService.resetUserPassword(req.params.id, payload.newPassword);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.PASSWORD_CHANGED,
            entity: 'users',
            entityId: req.params.id,
            req,
            metadata: { by_admin: true },
        });

        return sendSuccess(res, 'Password reset successfully');
    }),

    // -------------------------------------------------------------------------
    // Roles and permissions
    // -------------------------------------------------------------------------

    /** GET /api/admin/roles */
    listRoles: asyncHandler(async (req, res) => {
        const roles = await adminService.listRolesWithPermissions();
        return sendSuccess(res, 'Roles retrieved', { roles });
    }),

    /** GET /api/admin/permissions */
    listPermissions: asyncHandler(async (req, res) => {
        const permissions = await adminService.listPermissions();
        return sendSuccess(res, 'Permissions retrieved', { permissions });
    }),

    /** PUT /api/admin/roles/:id/permissions */
    setRolePermissions: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const roles = await adminService.setRolePermissions(req.params.id, payload.permissions);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.ROLE_UPDATED,
            entity: 'roles',
            entityId: req.params.id,
            req,
            metadata: { permission_count: payload.permissions.length },
        });

        return sendSuccess(res, 'Role permissions updated', { roles });
    }),

    // -------------------------------------------------------------------------
    // Activity
    // -------------------------------------------------------------------------

    /** GET /api/admin/activity */
    recentActivity: asyncHandler(async (req, res) => {
        const activity = await adminService.recentActivity(req.query.limit);
        return sendSuccess(res, 'Activity retrieved', { activity });
    }),
};

export default adminController;