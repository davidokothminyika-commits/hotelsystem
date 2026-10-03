/**
 * src/controllers/review.controller.js
 *
 * WHAT THIS MODULE DOES
 * Translates review HTTP requests into review service calls.
 *
 * WHY IT EXISTS
 * Keeps the controller free of business rules. The guest-versus-staff
 * distinction is resolved in the service, so this file only moves data between
 * Express and the service.
 *
 * EVERY HANDLER IS WRAPPED IN asyncHandler
 * Express 4 does not catch rejected promises from async handlers, so an
 * unwrapped throw escapes the router and hangs the request.
 *
 * COMMUNICATION
 * Browser -> /api/reviews -> THIS FILE -> services/review.service.js
 * Database tables used: none (the service owns persistence).
 */
import reviewService from '../services/review.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';

const reviewController = {
    /** GET /api/reviews */
    list: asyncHandler(async (req, res) => {
        const result = await reviewService.listPublic({
            page: req.query.page,
            limit: req.query.limit,
            entityType: req.query.entityType,
            entityId: req.query.entityId,
            minRating: req.query.minRating,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Reviews retrieved',
        );
    }),

    /**
     * GET /api/reviews/moderation
     * Staff listing. Unlike the public list this may include hidden reviews so
     * a manager can find and restore something that was taken down.
     */
    listForStaff: asyncHandler(async (req, res) => {
        const result = await reviewService.listForStaff({
            page: req.query.page,
            limit: req.query.limit,
            entityType: req.query.entityType,
            minRating: req.query.minRating,
            flaggedOnly: req.query.flaggedOnly,
            search: req.query.search,
            includeHidden: req.query.includeHidden,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Reviews retrieved',
        );
    }),

    /** GET /api/reviews/stats */
    stats: asyncHandler(async (req, res) => {
        const stats = await reviewService.stats(req.query.entityType);
        sendSuccess(res, 'Review statistics retrieved', { stats });
    }),

    /** GET /api/reviews/mine */
    mine: asyncHandler(async (req, res) => {
        const review = await reviewService.getMine(
            { entityType: req.query.entityType, entityId: req.query.entityId },
            req.user,
        );
        sendSuccess(res, 'Review retrieved', { review });
    }),

    /** GET /api/reviews/:id */
    getOne: asyncHandler(async (req, res) => {
        const review = await reviewService.getOne(req.params.id, req.user);
        sendSuccess(res, 'Review retrieved', { review });
    }),

    /** POST /api/reviews */
    create: asyncHandler(async (req, res) => {
        const review = await reviewService.create(
            {
                entityType: req.body.entityType,
                entityId: req.body.entityId,
                rating: req.body.rating,
                title: req.body.title,
                comment: req.body.comment,
            },
            req.user,
        );
        sendCreated(res, 'Thank you for your review', { review });
    }),

    /** POST /api/reviews/:id/reply */
    reply: asyncHandler(async (req, res) => {
        const review = await reviewService.reply(req.params.id, req.body.reply, req.user);
        sendSuccess(res, 'Reply published', { review });
    }),

    /** PATCH /api/reviews/:id/visibility */
    setVisibility: asyncHandler(async (req, res) => {
        const review = await reviewService.setVisibility(
            req.params.id,
            Boolean(req.body.isVisible),
            req.user,
        );
        sendSuccess(
            res,
            review.isVisible ? 'Review is now publicly visible' : 'Review hidden from public view',
            { review },
        );
    }),

    /** PATCH /api/reviews/:id/flag */
    setFlagged: asyncHandler(async (req, res) => {
        const review = await reviewService.setFlagged(
            req.params.id,
            Boolean(req.body.isFlagged),
            req.user,
        );
        sendSuccess(res, review.isFlagged ? 'Review flagged' : 'Flag removed', { review });
    }),

    /** DELETE /api/reviews/:id */
    remove: asyncHandler(async (req, res) => {
        await reviewService.remove(req.params.id, req.user);
        sendSuccess(res, 'Review deleted');
    }),
};

export default reviewController;
