/**
 * src/routes/reviews.routes.js
 *
 * WHAT THIS MODULE DOES
 * The guest review surface: public reading, guest writing, staff moderation.
 *
 * WHY IT EXISTS
 * Reviews are the one resource here with two audiences of equal standing on
 * the same URL space, so the split between what a guest may do and what only
 * staff may do has to be readable in one screen. The rule is simple and stated
 * once here: anyone signed in may read and write, only moderators may change
 * visibility, flag or reply.
 *
 * MIDDLEWARE ORDER MATTERS HERE
 * Literal paths (`/stats`, `/mine`, `/moderation`) are declared before
 * `/:id`, otherwise Express matches them as an identifier.
 *
 * COMMUNICATION
 * Browser -> /api/reviews/* -> reviews.controller.js -> review.service.js
 * Database tables used: reviews, users
 */
import { Router } from 'express';
import reviewController from '../controllers/review.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import {
    listReviewsRules,
    staffReviewListRules,
    reviewIdRules,
    createReviewRules,
    replyReviewRules,
    visibilityRules,
    flagRules,
} from '../validators/review.validators.js';

const router = Router();

/** Staff who may moderate guest reviews. */
const moderator = requireRole('receptionist', 'manager', 'admin');

// Reading reviews is public: the marketing site shows them before sign in.
router.get('/', validate(listReviewsRules), reviewController.list);
router.get('/stats', reviewController.stats);

router.use(requireAuth);

router.get('/mine', reviewController.mine);
router.get('/moderation', moderator, validate(staffReviewListRules), reviewController.listForStaff);

router.post('/', writeLimiter, validate(createReviewRules), reviewController.create);
router.post('/:id/reply', moderator, validate(replyReviewRules), reviewController.reply);
router.patch('/:id/visibility', moderator, validate(visibilityRules), reviewController.setVisibility);
router.patch('/:id/flag', moderator, validate(flagRules), reviewController.setFlagged);
router.delete('/:id', moderator, validate(reviewIdRules), reviewController.remove);
router.get('/:id', validate(reviewIdRules), reviewController.getOne);

export default router;
