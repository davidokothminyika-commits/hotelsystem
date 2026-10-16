/**
 * src/validators/bookingGroup.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for group (allotment) endpoints.
 *
 * WHY THE ROOM RULES ARE SHARED WITH BOOKING CREATION
 * A room inside a block carries the same optional guest counts and special
 * requests as a standalone booking. Declaring `rooms.*.x` here rather than
 * reusing the single-booking rules keeps the two shapes independent: a group
 * needs an array with at least one entry, a booking needs one roomId. The
 * date rule itself is imported from booking.validators so the calendar cannot
 * drift between the two paths.
 *
 * COMMUNICATION
 * Used by: src/routes/bookingGroup.routes.js
 * Database tables used: none.
 */
import { body, query } from 'express-validator';
import { dateBodyRule, idParamRules } from './booking.validators.js';

/** The optional per-room fields, applied to every element of `rooms`. */
const roomFieldRules = [
    body('rooms.*.roomId')
        .isInt({ min: 1 })
        .withMessage('Each room must be a valid room id')
        .toInt(),
    body('rooms.*.guests')
        .optional()
        .isInt({ min: 1, max: 20 })
        .withMessage('Number of guests must be between 1 and 20')
        .toInt(),
    body('rooms.*.adults')
        .optional()
        .isInt({ min: 1, max: 20 })
        .withMessage('Invalid adult count')
        .toInt(),
    body('rooms.*.children')
        .optional()
        .isInt({ min: 0, max: 20 })
        .withMessage('Invalid child count')
        .toInt(),
    body('rooms.*.specialRequests')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 1000 })
        .withMessage('Special requests must be under 1000 characters'),
];

export const createGroupRules = [
    body('name')
        .notEmpty()
        .withMessage('The group needs a name')
        .bail()
        .trim()
        .isLength({ min: 2, max: 120 })
        .withMessage('The name must be between 2 and 120 characters'),
    body('contactName')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 80 })
        .withMessage('Contact name is too long'),
    body('contactEmail')
        .optional({ values: 'falsy' })
        .trim()
        .isEmail()
        .withMessage('Contact email must be a valid address')
        .normalizeEmail(),
    body('contactPhone')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 40 })
        .withMessage('Contact phone is too long'),
    body('notes')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 500 })
        .withMessage('Notes must be under 500 characters'),

    dateBodyRule('checkIn', 'Check-in date'),
    dateBodyRule('checkOut', 'Check-out date'),

    body('rooms')
        .isArray({ min: 1, max: 20 })
        .withMessage('A group needs between 1 and 20 rooms'),
    ...roomFieldRules,
];

export const addRoomsRules = [
    body('rooms')
        .isArray({ min: 1, max: 20 })
        .withMessage('Add between 1 and 20 rooms at a time'),
    ...roomFieldRules,
];

export const listGroupsRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .isIn(['tentative', 'confirmed', 'cancelled'])
        .withMessage('Invalid group status'),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('sortBy')
        .optional()
        .isIn(['g.created_at', 'g.check_in', 'g.name', 'g.status'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

export const cancelGroupRules = [
    body('reason')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 255 })
        .withMessage('Reason must be under 255 characters'),
];

export { idParamRules };
