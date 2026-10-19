/**
 * src/validators/rate.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the rate endpoints: managing rules and asking for a
 * price quote.
 *
 * WHY triggerType IS VALIDATED AS A DISCRIMINATOR
 * The two rule shapes share one table. The service enforces the *combination*
 * (a date window for date_range, a threshold for occupancy); this file pins
 * down the field shapes so the service can reason about the data without
 * re-checking types.
 *
 * COMMUNICATION
 * Used by: src/routes/rate.routes.js
 * Database tables used: none.
 */
import { body, query } from 'express-validator';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dateBodyOptional = (field, label) =>
    body(field)
        .optional({ values: 'falsy' })
        .isISO8601({ strict: true })
        .withMessage(`${label} must be a valid date in YYYY-MM-DD format`);

export const createRuleRules = [
    body('name')
        .notEmpty()
        .withMessage('Name the rule')
        .bail()
        .trim()
        .isLength({ min: 2, max: 80 })
        .withMessage('The name must be between 2 and 80 characters'),
    body('roomTypeId')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Invalid room type')
        .toInt(),
    body('triggerType')
        .optional()
        .isIn(['date_range', 'occupancy'])
        .withMessage('A rule is either a date range or occupancy based'),
    dateBodyOptional('startDate', 'Start date'),
    dateBodyOptional('endDate', 'End date'),
    body('daysOfWeek')
        .optional({ values: null })
        .custom((value) => {
            if (value === null) return true;
            const chosen = Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
            return chosen.length === 0 || chosen.every((d) => DAYS.includes(d));
        })
        .withMessage(`Days must be from: ${DAYS.join(', ')}`),
    body('occupancyThreshold')
        .optional({ values: null })
        .isFloat({ min: 0, max: 100 })
        .withMessage('The threshold must be a percentage between 0 and 100')
        .toFloat(),
    body('adjustmentType')
        .optional()
        .isIn(['percent', 'fixed'])
        .withMessage('Adjust by percent or by a fixed amount'),
    body('adjustmentValue')
        .notEmpty()
        .withMessage('Give the adjustment amount')
        .bail()
        .isFloat({ nonzero: true })
        .withMessage('The adjustment must not be zero')
        .toFloat(),
    body('priority').optional().isInt({ min: 1 }).withMessage('Invalid priority').toInt(),
    body('isActive').optional().isBoolean().toBoolean(),
];

/**
 * PATCH: every field may be absent, including `name`, which creation demands.
 * `notEmpty` at the HTTP boundary does not reject *absent* fields, so reusing
 * the creation chains here is safe: the rules only fire when the client sent
 * the key.
 */
// Make adjustmentValue optional for PATCH (creation requires it, updates may omit it)
export const updateRuleRules = [
    body('name')
        .optional({ values: 'falsy' })
        .notEmpty()
        .withMessage('Name the rule')
        .bail()
        .trim()
        .isLength({ min: 2, max: 80 })
        .withMessage('The name must be between 2 and 80 characters'),
    body('roomTypeId')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Invalid room type')
        .toInt(),
    body('triggerType')
        .optional()
        .isIn(['date_range', 'occupancy'])
        .withMessage('A rule is either a date range or occupancy based'),
    dateBodyOptional('startDate', 'Start date'),
    dateBodyOptional('endDate', 'End date'),
    body('daysOfWeek')
        .optional({ values: null })
        .custom((value) => {
            if (value === null) return true;
            const chosen = Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
            return chosen.length === 0 || chosen.every((d) => DAYS.includes(d));
        })
        .withMessage(`Days must be from: ${DAYS.join(', ')}`),
    body('occupancyThreshold')
        .optional({ values: null })
        .isFloat({ min: 0, max: 100 })
        .withMessage('The threshold must be a percentage between 0 and 100')
        .toFloat(),
    body('adjustmentType')
        .optional()
        .isIn(['percent', 'fixed'])
        .withMessage('Adjust by percent or by a fixed amount'),
    body('adjustmentValue')
        .optional({ values: 'falsy' })
        .isFloat({ nonzero: true })
        .withMessage('The adjustment must not be zero')
        .toFloat(),
    body('priority').optional().isInt({ min: 1 }).withMessage('Invalid priority').toInt(),
    body('isActive').optional().isBoolean().toBoolean(),
];

export const listRulesRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('triggerType').optional().isIn(['date_range', 'occupancy']),
    query('isActive').optional().isIn(['true', 'false']),
    query('search').optional().trim().isLength({ max: 80 }),
    query('sortBy').optional().isIn(['r.priority', 'r.name', 'r.created_at', 'r.trigger_type']),
    query('sortDir').optional().isIn(['asc', 'desc']),
];

export const quoteRules = [
    query('roomId').isInt({ min: 1 }).withMessage('Choose a room').toInt(),
    query('checkIn')
        .isISO8601({ strict: true })
        .withMessage('Check-in must be a valid date in YYYY-MM-DD format'),
    query('checkOut')
        .isISO8601({ strict: true })
        .withMessage('Check-out must be a valid date in YYYY-MM-DD format'),
];
