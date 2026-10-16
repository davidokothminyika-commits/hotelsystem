/**
 * src/validators/maintenance.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for creating, listing and updating repair tickets.
 *
 * WHY assignedTo IS NOT REQUIRED TO EXIST AS A USER
 * The staff directory changes: a technician who left takes their open jobs
 * with them until someone reassigns. The route's permission guard decides who
 * may touch the field at all, and the service validates the id's shape before
 * it reaches SQL, where the foreign key makes a wrong id an error rather than
 * a silent assignment to nobody.
 *
 * COMMUNICATION
 * Used by: src/routes/maintenance.routes.js
 * Database tables used: none.
 */
import { body, query } from 'express-validator';
import { TICKET_STATUSES } from '../services/maintenance.service.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export const createTicketRules = [
    body('roomId')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Invalid room id')
        .toInt(),
    body('title')
        .notEmpty()
        .withMessage('Describe the problem, e.g. "Leaking tap in 204"')
        .bail()
        .trim()
        .isLength({ min: 3, max: 150 })
        .withMessage('The title must be between 3 and 150 characters'),
    body('description')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 2000 })
        .withMessage('Description is too long'),
    body('priority')
        .optional()
        .isIn(PRIORITIES)
        .withMessage('Priority must be one of low, normal, high or urgent'),
    body('assignedTo')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('The assignee must be a user id')
        .toInt(),
];

export const updateTicketRules = [
    body('title')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ min: 3, max: 150 })
        .withMessage('The title must be between 3 and 150 characters'),
    body('description')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 2000 })
        .withMessage('Description is too long'),
    body('priority')
        .optional({ values: 'falsy' })
        .isIn(PRIORITIES)
        .withMessage('Priority must be one of low, normal, high or urgent'),
    body('status')
        .optional({ values: 'falsy' })
        .isIn(TICKET_STATUSES)
        .withMessage(`Status must be one of: ${TICKET_STATUSES.join(', ')}`),
    body('assignedTo')
        .optional({ values: null })
        .isInt({ min: 1 })
        .withMessage('The assignee must be a user id')
        .toInt(),
    body('resolutionNotes')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 500 })
        .withMessage('Resolution notes must be under 500 characters'),
];

export const listTicketRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .custom((value) => {
            const chosen = String(value).split(',').map((item) => item.trim()).filter(Boolean);
            return chosen.every((item) => TICKET_STATUSES.includes(item));
        })
        .withMessage('Invalid ticket status'),
    query('openOnly')
        .optional()
        .isIn(['true', '1'])
        .withMessage('openOnly must be true'),
    query('priority').optional()
        .custom((value) => {
            const chosen = String(value).split(',').map((item) => item.trim()).filter(Boolean);
            return chosen.every((item) => PRIORITIES.includes(item));
        }),
    query('roomId').optional().isInt({ min: 1 }).withMessage('Invalid room').toInt(),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('sortBy').optional().isIn(['m.created_at', 'm.priority', 'm.status', 'r.room_number']),
    query('sortDir').optional().isIn(['asc', 'desc']),
];
