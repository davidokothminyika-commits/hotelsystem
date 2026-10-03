/**
 * src/services/review.service.js
 *
 * WHAT THIS MODULE DOES
 * Business rules for guest reviews and their moderation.
 *
 * WHY IT EXISTS
 * Two audiences read this data with different rights. A guest may write and
 * read their own review; staff may moderate any review but must not be able to
 * write one in a guest's name. Keeping those rules here means the controller
 * only translates HTTP.
 *
 * ONE REVIEW PER GUEST PER ENTITY
 * The schema enforces this with a unique key, but the check is done here too so
 * the guest gets a clear 409 instead of a driver-level duplicate entry error.
 *
 * COMMUNICATION
 * Browser -> /api/reviews -> reviews.controller.js -> THIS FILE
 *          -> review.repository.js, audit.service.js, notification.service.js
 * Database tables used: reviews, users, rooms, menu_items, bookings
 */
import ApiError from '../utils/errors.js';
import reviewRepository from '../repositories/review.repository.js';
import notificationService from './notification.service.js';
import auditService, { AUDIT_ACTIONS } from './audit.service.js';

/** What can be reviewed. */
export const REVIEW_ENTITIES = Object.freeze(['hotel', 'room', 'restaurant', 'food_item', 'service', 'booking']);

/** Roles allowed to moderate. */
const MODERATOR_ROLES = ['receptionist', 'manager', 'admin'];

/** Guests may only review these; the rest are staff-only concepts. */
const GUEST_REVIEWABLE = ['hotel', 'room', 'restaurant', 'food_item', 'service'];

/**
 * Confirms the thing being reviewed exists.
 *
 * Without this, a review could point at a deleted room and render as a broken
 * reference. A 404 is correct: the guest asked to review something that is not
 * there.
 */
async function assertEntityExists(entityType, entityId) {
    const { queryOne } = await import('../config/db.js');

    const table = {
        room: { table: 'rooms', column: 'id' },
        food_item: { table: 'menu_items', column: 'id' },
        booking: { table: 'bookings', column: 'id' },
    }[entityType];

    // hotel, restaurant and service are about the property itself and have no row.
    if (!table) return;

    if (!entityId) {
        throw ApiError.badRequest('Specify which item you are reviewing', 'ENTITY_ID_REQUIRED');
    }

    const row = await queryOne(
        `SELECT ${table.column} FROM ${table.table} WHERE ${table.column} = :id`,
        { id: entityId },
    );
    if (!row) throw ApiError.notFound('The item you are reviewing was not found', 'REVIEW_TARGET_NOT_FOUND');
}

const reviewService = {
    /**
     * Public listing. Hidden reviews are excluded here rather than at the
     * controller, so no caller can accidentally ask for them by omission.
     */
    async listPublic({ page, limit, entityType, entityId, minRating }) {
        return reviewRepository.findMany({
            page,
            limit,
            entityType,
            entityId,
            minRating,
            includeHidden: false,
        });
    },

    /** Moderation listing. Staff may include hidden rows to restore them. */
    async listForStaff({ page, limit, entityType, minRating, flaggedOnly, search, includeHidden }) {
        return reviewRepository.findMany({
            page,
            limit,
            entityType,
            minRating,
            flaggedOnly,
            search,
            includeHidden,
        });
    },

    async stats(entityType) {
        return reviewRepository.stats(entityType);
    },

    /** One review. A hidden review is invisible to the public. */
    async getOne(id, requester) {
        const review = await reviewRepository.findById(id);
        if (!review) throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');

        const isStaff = MODERATOR_ROLES.includes(requester?.role);
        if (!review.isVisible && !isStaff) {
            throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');
        }

        return review;
    },

    /** The signed in guest's own review for an entity. */
    async getMine({ entityType, entityId }, requester) {
        return reviewRepository.findByUserAndEntity(requester.id, entityType, entityId);
    },

    async create({ entityType, entityId, rating, title, comment }, requester) {
        if (!REVIEW_ENTITIES.includes(entityType)) {
            throw ApiError.badRequest('Choose something valid to review', 'INVALID_ENTITY_TYPE');
        }
        if (!GUEST_REVIEWABLE.includes(entityType)) {
            throw ApiError.badRequest('That cannot be reviewed', 'NOT_REVIEWABLE');
        }

        await assertEntityExists(entityType, entityId);

        const existing = await reviewRepository.findByUserAndEntity(requester.id, entityType, entityId);
        if (existing) {
            throw ApiError.conflict('You have already reviewed this', 'ALREADY_REVIEWED');
        }

        const id = await reviewRepository.create({
            userId: requester.id,
            entityType,
            entityId,
            rating,
            title,
            comment,
        });

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.REVIEW_CREATED,
            entity: 'review',
            entityId: id,
            metadata: { entity_type: entityType, rating },
        });

        return reviewRepository.findById(id);
    },

    /**
     * Staff reply.
     *
     * Recorded as a moderation action because it is published under the hotel's
     * name: it must be attributable and reversible by a manager.
     */
    async reply(id, staffReply, requester) {
        const review = await reviewRepository.findById(id);
        if (!review) throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');

        await reviewRepository.reply(id, staffReply);

        await notificationService.create({
            userId: review.userId,
            type: 'review_response',
            title: 'The hotel replied to your review',
            body: staffReply.slice(0, 200),
            data: { url: '/pages/guest/dashboard.html', review_id: review.id },
        });

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.REVIEW_MODERATED,
            entity: 'review',
            entityId: id,
            metadata: { action: 'reply' },
        });

        return reviewRepository.findById(id);
    },

    async setVisibility(id, isVisible, requester) {
        const review = await reviewRepository.findById(id);
        if (!review) throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');

        await reviewRepository.setVisibility(id, isVisible);

        // Only tell the guest when a review they could see has been taken down.
        if (!isVisible) {
            await notificationService.create({
                userId: review.userId,
                type: 'review_hidden',
                title: 'A review was removed from public view',
                body: `Your review "${review.title}" is no longer shown publicly. Contact the hotel if you have questions.`,
                data: { url: '/pages/guest/dashboard.html', review_id: review.id },
            });
        }

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.REVIEW_MODERATED,
            entity: 'review',
            entityId: id,
            metadata: { action: isVisible ? 'show' : 'hide' },
        });

        return reviewRepository.findById(id);
    },

    async setFlagged(id, isFlagged, requester) {
        const review = await reviewRepository.findById(id);
        if (!review) throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');

        await reviewRepository.setFlagged(id, isFlagged);

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.REVIEW_MODERATED,
            entity: 'review',
            entityId: id,
            metadata: { action: isFlagged ? 'flag' : 'unflag' },
        });

        return reviewRepository.findById(id);
    },

    async remove(id, requester) {
        const review = await reviewRepository.findById(id);
        if (!review) throw ApiError.notFound('Review not found', 'REVIEW_NOT_FOUND');

        await reviewRepository.remove(id);

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.REVIEW_MODERATED,
            entity: 'review',
            entityId: id,
            metadata: { action: 'delete', title: review.title },
        });

        return { id: Number(id) };
    },
};

export default reviewService;
