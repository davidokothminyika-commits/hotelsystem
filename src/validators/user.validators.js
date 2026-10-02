/**
 * src/validators/user.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for profile self-service and administrator user management.
 *
 * WHY IT EXISTS
 * Keeps input rules in one place, separate from both the routes that apply
 * them and the services that enforce business rules.
 *
 * COMMUNICATION
 * Used by: src/routes/users.routes.js and src/routes/admin.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';

/** Shared name rules so register, profile and admin forms behave identically. */
const nameRules = (field, label) => [
    body(field)
        .trim()
        .notEmpty()
        .withMessage(`${label} is required`)
        .bail()
        .isLength({ min: 2, max: 80 })
        .withMessage(`${label} must be between 2 and 80 characters`)
        .matches(/^[\p{L}\s'.-]+$/u)
        .withMessage(`${label} may only contain letters, spaces, apostrophes, dots and hyphens`),
];

const phoneRule = (field = 'phone') =>
    body(field)
        .optional({ values: 'falsy' })
        .trim()
        .matches(/^[+]?[\d\s()-]{7,20}$/)
        .withMessage('Please enter a valid phone number');

/** Route param for a numeric :id. */
export const idParamRules = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Invalid identifier')
        .toInt(),
];

// ---------------------------------------------------------------------------
// Profile self-service
// ---------------------------------------------------------------------------

export const updateProfileRules = [...nameRules('firstName', 'First name'), ...nameRules('lastName', 'Last name'), phoneRule()];

export const changeEmailRules = [
    body('email')
        .trim()
        .notEmpty()
        .withMessage('A new email address is required')
        .bail()
        .isEmail()
        .withMessage('Please enter a valid email address')
        .normalizeEmail({ gmail_remove_dots: false })
        .isLength({ max: 190 })
        .withMessage('Email address is too long'),
    body('password').notEmpty().withMessage('Confirm your password to change your email'),
];

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

/** Roles an administrator may assign. Mirrors the seeded role table. */
export const ASSIGNABLE_ROLES = ['guest', 'receptionist', 'restaurant_staff', 'housekeeping', 'manager', 'admin'];

export const listUsersRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('role').optional().isIn(ASSIGNABLE_ROLES).withMessage('Unknown role'),
    query('isActive').optional().isIn(['0', '1']).withMessage('Invalid active flag'),
    query('sortBy')
        .optional()
        .isIn(['u.created_at', 'u.last_name', 'u.first_name', 'u.email', 'r.name', 'u.last_login_at', 'u.is_active'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

export const createUserRules = [
    ...nameRules('firstName', 'First name'),
    ...nameRules('lastName', 'Last name'),
    body('email')
        .trim()
        .notEmpty()
        .withMessage('Email address is required')
        .bail()
        .isEmail()
        .withMessage('Please enter a valid email address')
        .normalizeEmail({ gmail_remove_dots: false }),
    phoneRule(),
    body('password')
        .notEmpty()
        .withMessage('A password is required')
        .bail()
        .isLength({ min: 8, max: 128 })
        .withMessage('Password must be between 8 and 128 characters'),
    body('role')
        .notEmpty()
        .withMessage('A role is required')
        .bail()
        .isIn(ASSIGNABLE_ROLES)
        .withMessage('Unknown role'),
];

export const updateUserRules = [
    ...nameRules('firstName', 'First name'),
    ...nameRules('lastName', 'Last name'),
    phoneRule(),
    body('role').optional().isIn(ASSIGNABLE_ROLES).withMessage('Unknown role'),
    body('isActive').optional().isBoolean().withMessage('Invalid active flag').toBoolean(),
];

export const adminResetPasswordRules = [
    body('newPassword')
        .notEmpty()
        .withMessage('A new password is required')
        .bail()
        .isLength({ min: 8, max: 128 })
        .withMessage('Password must be between 8 and 128 characters'),
];

export const setRolePermissionsRules = [
    body('permissions')
        .isArray({ min: 1 })
        .withMessage('At least one permission is required')
        .bail()
        .custom((codes) => codes.every((code) => typeof code === 'string'))
        .withMessage('Permissions must be an array of codes'),
];

export default {
    idParamRules,
    updateProfileRules,
    changeEmailRules,
    listUsersRules,
    createUserRules,
    updateUserRules,
    adminResetPasswordRules,
    setRolePermissionsRules,
    ASSIGNABLE_ROLES,
};