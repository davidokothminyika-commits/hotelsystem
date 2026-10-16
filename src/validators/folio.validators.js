/**
 * src/validators/folio.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the folio endpoints: posting a charge or credit,
 * voiding one, and filtering the folio board.
 *
 * WHY THE AMOUNT IS A POSITIVE NUMBER
 * `folio_entries.amount` is always positive and `entry_type` decides the sign,
 * so a client that sent -50 would otherwise create a "credit" that actually
 * charges money - which is how a mistaken discount becomes a bill that will
 * not reconcile. Express validators `isFloat({ gt: 0 })` closes that door at
 * the boundary, and the service re-checks it.
 *
 * COMMUNICATION
 * Used by: src/routes/folio.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';
import { FOLIO_ENTRY_TYPES } from '../services/folio.service.js';

export const postEntryRules = [
    body('entryType')
        .notEmpty()
        .withMessage('Choose a charge or a credit')
        .bail()
        .isIn(FOLIO_ENTRY_TYPES)
        .withMessage('An entry must be a charge or a credit'),
    body('description')
        .notEmpty()
        .withMessage('Describe the entry, e.g. "Minibar"')
        .bail()
        .trim()
        .isLength({ min: 2, max: 160 })
        .withMessage('The description must be between 2 and 160 characters'),
    body('amount')
        .notEmpty()
        .withMessage('Enter an amount')
        .bail()
        .isFloat({ gt: 0, le: 999999.99 })
        .withMessage('The amount must be greater than zero')
        .toFloat(),
];

export const voidEntryRules = [
    body('reason')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 255 })
        .withMessage('Reason must be under 255 characters'),
];

/**
 * Path parameters for the per-booking folio routes. Declared here rather than
 * reused from booking.validators for the entry id, which only this feature
 * has.
 */
export const folioParamRules = [
    param('bookingId').isInt({ min: 1 }).withMessage('Invalid booking').toInt(),
];

export const folioEntryParamRules = [
    param('bookingId').isInt({ min: 1 }).withMessage('Invalid booking').toInt(),
    param('entryId').isInt({ min: 1 }).withMessage('Invalid folio entry').toInt(),
];

export const listFoliosRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .isIn(['all', 'owing'])
        .withMessage('Invalid folio filter'),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
];


