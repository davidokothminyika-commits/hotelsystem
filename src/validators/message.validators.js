/**
 * src/validators/message.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the messaging endpoints.
 *
 * WHY IT EXISTS
 * Keeps input rules separate from both the routes that apply them and the
 * service that enforces conversation membership.
 *
 * A NOTE ON MESSAGE LENGTH
 * The cap is generous because a guest describing a problem in a few words is
 * fine, but an unbounded body field is an unbounded amount of data in a table
 * every other participant has to load.
 *
 * COMMUNICATION
 * Used by: src/routes/messages.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';

const CONTEXT_TYPES = ['support', 'reception', 'restaurant', 'booking'];

export const idParamRules = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Invalid identifier')
        .toInt(),
];

export const listConversationsRules = [
    query('includeClosed').optional().isBoolean().withMessage('Invalid flag').toBoolean(),
];

export const staffInboxRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('includeClosed').optional().isBoolean().withMessage('Invalid flag').toBoolean(),
    query('search').optional().trim().isLength({ max: 120 }).withMessage('Search term is too long'),
];

export const createConversationRules = [
    body('subject')
        .optional()
        .trim()
        .isLength({ min: 3, max: 80 })
        .withMessage('Subject must be between 3 and 80 characters'),
    body('contextType')
        .optional()
        .isIn(CONTEXT_TYPES)
        .withMessage('Choose a valid conversation type'),
    // Only meaningful for staff opening a thread with a named guest; the
    // service requires it in that case and ignores it otherwise.
    body('recipientIds').optional().isArray({ max: 20 }).withMessage('Invalid recipients'),
    body('recipientIds.*').optional().isInt({ min: 1 }).withMessage('Invalid recipient').toInt(),
];

export const sendMessageRules = [
    ...idParamRules,
    body('body')
        .trim()
        .isLength({ min: 1, max: 4000 })
        .withMessage('Write a message between 1 and 4000 characters'),
];

export const closeConversationRules = [
    ...idParamRules,
    body('isClosed')
        .isBoolean()
        .withMessage('Specify whether the conversation is closed')
        .toBoolean(),
];
