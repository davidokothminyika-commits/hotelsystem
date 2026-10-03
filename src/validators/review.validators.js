/**
 * src/validators/review.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the review endpoints.
 *
 * WHY IT EXISTS
 * The rating range is enforced in the database by a CHECK constraint, but a
 * request carrying a rating of 9 should be told what is wrong in a 422 rather
 * than failing at the driver with a constraint violation, so the range is
 * checked at the boundary too.
 *
 * COMMUNICATION
 * Used by: routes/reviews.routes.js via middleware/validation.middleware.js
 */
import { body, param, query } from 'express-validator';

const ENTITIES = ['hotel', 'room', 'restaurant', 'food_item', 'service', 'booking'];

export const listReviewsRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('entityType').optional().isIn(ENTITIES).withMessage('Unknown review type'),
    query('entityId').optional().isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
    query('minRating').optional().isInt({ min: 1, max: 5 }).withMessage('Invalid rating').toInt(),
];

export const staffReviewListRules = [
    ...listReviewsRules,
    query('search').optional().trim().isLength({ max: 120 }).withMessage('Search term is too long'),
    // Hidden reviews are only ever included for the moderation screen.
    query('includeHidden').optional().isBoolean().withMessage('Invalid flag').toBoolean(),
    query('flaggedOnly').optional().isBoolean().withMessage('Invalid flag').toBoolean(),
];

export const reviewIdRules = [param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt()];

export const createReviewRules = [
    body('entityType').isIn(ENTITIES).withMessage('Choose something valid to review'),
    body('entityId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Choose a rating from 1 to 5').toInt(),
    body('title').trim().isLength({ min: 3, max: 150 }).withMessage('Give your review a short title'),
    body('comment').trim().isLength({ min: 10, max: 5000 }).withMessage(
        'Your review must be between 10 and 5000 characters',
    ),
];

export const replyReviewRules = [
    ...reviewIdRules,
    body('reply').trim().isLength({ min: 2, max: 2000 }).withMessage(
        'Write a reply between 2 and 2000 characters',
    ),
];

export const visibilityRules = [
    ...reviewIdRules,
    body('isVisible').isBoolean().withMessage('Specify whether the review is visible').toBoolean(),
];

export const flagRules = [
    ...reviewIdRules,
    body('isFlagged').isBoolean().withMessage('Specify whether the review is flagged').toBoolean(),
];
