/**
 * src/validators/audit.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the audit log listing endpoint.
 *
 * WHY IT EXISTS
 * The audit screen has a wider filter set than any other list in the
 * application, and a free-text `search` reaches a LIKE against two columns.
 * The length cap keeps that bounded.
 *
 * COMMUNICATION
 * Used by: src/routes/audit.routes.js
 * Database tables used: none.
 */
import { query } from 'express-validator';

export const listAuditRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    // Capped lower than most lists: the audit log is the densest table read by
    // an administrator, and nobody scans five hundred rows looking for one line.
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Invalid page size').toInt(),
    query('search').optional().trim().isLength({ min: 1, max: 120 }).withMessage('Search term is too long'),
    query('action').optional().trim().isLength({ max: 80 }).withMessage('Invalid action'),
    query('userId').optional().isInt({ min: 1 }).withMessage('Invalid user').toInt(),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
];

export const recentAuditRules = [
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Invalid page size').toInt(),
];
