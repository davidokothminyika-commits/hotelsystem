/**
 * src/routes/admin.routes.js
 *
 * WHAT THIS MODULE DOES
 * Administrator-only endpoints for managing users, roles and permissions.
 *
 * WHY IT EXISTS
 * Mounting the whole admin surface behind one `requireRole('admin')` guard
 * means a new admin route is protected the moment it is added here. Forgetting
 * to protect an endpoint is much harder than forgetting to document it.
 *
 * DEFENCE IN DEPTH
 * `router.use(requireRole('admin'))` protects everything below. Individual
 * routes are not required to repeat the check, which keeps the file readable
 * and removes the chance of a copy-paste slip.
 *
 * COMMUNICATION
 * Frontend (public/js/api/admin.js) -> THIS FILE -> admin.controller.js
 * Database tables used: users, roles, permissions, role_permissions, audit_logs.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { auditAction } from '../middleware/audit.middleware.js';
import {
    idParamRules,
    listUsersRules,
    createUserRules,
    updateUserRules,
    adminResetPasswordRules,
    setRolePermissionsRules,
} from '../validators/user.validators.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import adminController from '../controllers/admin.controller.js';

const router = Router();

// Every route in this file requires an authenticated administrator.
router.use(requireAuth, requireRole('admin'));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get('/users', validate(listUsersRules), adminController.listUsers);

router.get('/users/:id', validate(idParamRules), adminController.getUser);

router.post(
    '/users',
    writeLimiter,
    validate(createUserRules),
    auditAction(AUDIT_ACTIONS.USER_CREATED, (req) => ({ entity: 'users' })),
    adminController.createUser,
);

router.patch('/users/:id', validate([...idParamRules, ...updateUserRules]), adminController.updateUser);

router.delete('/users/:id', validate(idParamRules), adminController.deleteUser);

router.post(
    '/users/:id/reset-password',
    validate([...idParamRules, ...adminResetPasswordRules]),
    adminController.resetUserPassword,
);

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

router.get('/roles', adminController.listRoles);

router.get('/permissions', adminController.listPermissions);

router.put(
    '/roles/:id/permissions',
    validate([...idParamRules, ...setRolePermissionsRules]),
    adminController.setRolePermissions,
);

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

router.get('/activity', adminController.recentActivity);

export default router;