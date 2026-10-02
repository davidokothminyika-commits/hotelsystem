/**
 * src/middleware/authorization.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Guards routes by role name or by fine grained permission code.
 *
 * WHY IT EXISTS
 * Authentication answers "who is this?" and authorization answers "may they
 * do this?". Keeping them separate means a route declares its requirement in
 * one readable line instead of scattering `if (req.user.role === ...)` checks
 * through controllers.
 *
 * TWO LEVELS OF CONTROL
 *   Role based   -> requireRole('admin', 'manager') is quick to read and
 *                   matches how the hotel actually organises teams.
 *   Permission based -> requirePermission('booking:update') is more precise
 *                   and lives in the role_permissions table, so access can be
 *                   changed in the database without editing code.
 *
 * Both checks require `requireAuth` to run first, otherwise `req.user` is
 * undefined and the guard fails closed.
 *
 * COMMUNICATION
 * Used by: routes in src/routes/.
 * Reads:   req.user populated by requireAuth.
 * Database tables used: users, roles, permissions, role_permissions.
 */
import ApiError from '../utils/errors.js';
import permissionRepository from '../repositories/permission.repository.js';

/**
 * Small in-process cache for the permission map.
 *
 * Why cache at all: the permission set changes only when an administrator
 * edits a role, so re-reading it on every request would be wasted work. The
 * cache is invalidated explicitly by permissionRepository.invalidateCache()
 * after a change.
 */
const CACHE_TTL_MS = 60_000;
let permissionCache = { value: null, expiresAt: 0 };

async function getPermissionMap() {
    if (permissionCache.value && Date.now() < permissionCache.expiresAt) {
        return permissionCache.value;
    }

    const value = await permissionRepository.getRolePermissionMap();
    permissionCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
}

/**
 * Allows the request only if the user holds one of the listed roles.
 *
 * @param {...string} roles
 * @example router.post('/', requireAuth, requireRole('admin'), handler)
 */
export function requireRole(...roles) {
    const allowed = roles.flat().map((role) => String(role).toLowerCase());

    return function roleGuard(req, res, next) {
        if (!req.user) {
            return next(ApiError.unauthorized('You must be signed in to continue', 'NO_TOKEN'));
        }

        if (!allowed.includes(String(req.user.role).toLowerCase())) {
            return next(
                ApiError.forbidden(
                    `This action requires one of these roles: ${allowed.join(', ')}`,
                    'INSUFFICIENT_ROLE',
                ),
            );
        }

        return next();
    };
}

/**
 * Allows the request only if the user's role grants every listed permission.
 *
 * @param {...string} permissions Permission codes, e.g. 'booking:update'
 */
export function requirePermission(...permissions) {
    const required = permissions.flat();

    return async function permissionGuard(req, res, next) {
        try {
            if (!req.user) {
                return next(ApiError.unauthorized('You must be signed in to continue', 'NO_TOKEN'));
            }

            const map = await getPermissionMap();
            const granted = map[req.user.role] || new Set();

            const missing = required.filter((permission) => !granted.has(permission));
            if (missing.length > 0) {
                return next(
                    ApiError.forbidden(
                        `Missing required permission: ${missing.join(', ')}`,
                        'INSUFFICIENT_PERMISSION',
                    ),
                );
            }

            return next();
        } catch (error) {
            return next(error);
        }
    };
}

/**
 * Blocks guests from staff and admin areas.
 *
 * This is the single most important rule in the hotel: a guest booking a room
 * must never reach staff tooling. Kept as its own named guard so the intent
 * is obvious at the call site and in review.
 */
export function requireStaff(req, res, next) {
    if (!req.user) {
        return next(ApiError.unauthorized('You must be signed in to continue', 'NO_TOKEN'));
    }

    const staffRoles = ['receptionist', 'restaurant_staff', 'housekeeping', 'manager', 'admin'];
    if (!staffRoles.includes(req.user.role)) {
        return next(ApiError.forbidden('Staff access only', 'STAFF_ONLY'));
    }

    return next();
}

/** Allows any signed in account, including guests. */
export function requireAnyUser(req, res, next) {
    if (!req.user) {
        return next(ApiError.unauthorized('You must be signed in to continue', 'NO_TOKEN'));
    }
    return next();
}

export { getPermissionMap };
export default { requireRole, requirePermission, requireStaff, requireAnyUser };