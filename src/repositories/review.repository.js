/**
 * src/repositories/review.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for the `reviews` table.
 *
 * WHY IT EXISTS
 * Reviews are read publicly and moderated by staff, so both the listing query
 * and the rating aggregate live together here. The aggregate is computed by the
 * database rather than in JavaScript: pulling every row to average it in the
 * service would transfer the whole table to do arithmetic SQL can do.
 *
 * MODERATION IS A FIELD, NOT A DELETE
 * `is_visible` hides a review from the public listing without destroying it. A
 * hidden review stays in the table because the moderation decision is itself
 * part of the record, and a manager may want to restore it.
 *
 * COMMUNICATION
 * Called by: services/review.service.js
 * Database tables used: reviews, users
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolvePagination } from './base.repository.js';

function mapReview(row) {
    return {
        id: row.id,
        userId: row.user_id,
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityLabel: row.entity_label,
        rating: Number(row.rating),
        title: row.title,
        comment: row.comment,
        isVisible: Boolean(row.is_visible),
        isFlagged: Boolean(row.is_flagged),
        staffReply: row.staff_reply,
        repliedAt: row.replied_at,
        createdAt: row.created_at,
    };
}

const reviewRepository = {
    /**
     * Paginated review list.
     *
     * `includeHidden` exists for the admin moderation screen. The public
     * listing must never set it, otherwise a moderated review reappears.
     */
    async findMany({
        page = 1,
        limit = 20,
        entityType,
        entityId,
        minRating,
        flaggedOnly,
        includeHidden = false,
        search,
        userId,
    }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = {};

        // The public listing only ever returns visible rows. This is applied in
        // SQL rather than filtered afterwards so the count stays truthful.
        if (!includeHidden) conditions.push('r.is_visible = 1');

        if (entityType) {
            conditions.push('r.entity_type = :entityType');
            params.entityType = entityType;
        }
        if (entityId) {
            conditions.push('r.entity_id = :entityId');
            params.entityId = entityId;
        }
        if (minRating) {
            conditions.push('r.rating >= :minRating');
            params.minRating = minRating;
        }
        if (flaggedOnly) conditions.push('r.is_flagged = 1');
        if (userId) {
            conditions.push('r.user_id = :userId');
            params.userId = userId;
        }
        if (search) {
            conditions.push("(r.title LIKE :search OR r.comment LIKE :search OR u.email LIKE :search)");
            params.search = `%${search}%`;
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const from = `FROM reviews r
                     LEFT JOIN users u ON u.id = r.user_id
                     ${where}`;

        const rows = await query(
            `SELECT r.*, u.email AS guest_email,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    CASE r.entity_type
                        WHEN 'room' THEN (SELECT CONCAT('Room ', rm.room_number) FROM rooms rm WHERE rm.id = r.entity_id)
                        WHEN 'food_item' THEN (SELECT mi.name FROM menu_items mi WHERE mi.id = r.entity_id)
                        WHEN 'booking' THEN (SELECT b.booking_reference FROM bookings b WHERE b.id = r.entity_id)
                        ELSE NULL
                    END AS entity_label
             ${from}
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, params, { limit: pagination.limit, offset: pagination.offset }),
        );

        const countRow = await queryOne(`SELECT COUNT(*) AS total ${from}`, params);

        return {
            rows: rows.map(mapReview),
            total: countRow ? Number(countRow.total) : 0,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: Math.max(1, Math.ceil((countRow ? Number(countRow.total) : 0) / pagination.limit)),
        };
    },

    /**
     * Rating breakdown for the admin screen.
     *
     * Hidden reviews are excluded so the average a manager sees matches the
     * average a guest sees.
     */
    async stats(entityType) {
        const conditions = ['is_visible = 1'];
        const params = {};
        if (entityType) {
            conditions.push('entity_type = :entityType');
            params.entityType = entityType;
        }
        const where = conditions.join(' AND ');

        const summary = await queryOne(
            `SELECT COUNT(*) AS total,
                    COALESCE(AVG(rating), 0) AS average,
                    SUM(rating = 5) AS five,
                    SUM(rating = 4) AS four,
                    SUM(rating = 3) AS three,
                    SUM(rating = 2) AS two,
                    SUM(rating = 1) AS one
             FROM reviews WHERE ${where}`,
            params,
        );

        const flagged = await queryOne(
            'SELECT COUNT(*) AS total FROM reviews WHERE is_flagged = 1',
        );

        return {
            total: Number(summary?.total || 0),
            average: Number(Number(summary?.average || 0).toFixed(2)),
            distribution: {
                5: Number(summary?.five || 0),
                4: Number(summary?.four || 0),
                3: Number(summary?.three || 0),
                2: Number(summary?.two || 0),
                1: Number(summary?.one || 0),
            },
            flagged: Number(flagged?.total || 0),
        };
    },

    async findById(id) {
        const row = await queryOne(
            `SELECT r.*, u.email AS guest_email,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    CASE r.entity_type
                        WHEN 'room' THEN (SELECT CONCAT('Room ', rm.room_number) FROM rooms rm WHERE rm.id = r.entity_id)
                        WHEN 'food_item' THEN (SELECT mi.name FROM menu_items mi WHERE mi.id = r.entity_id)
                        WHEN 'booking' THEN (SELECT b.booking_reference FROM bookings b WHERE b.id = r.entity_id)
                        ELSE NULL
                    END AS entity_label
             FROM reviews r
             LEFT JOIN users u ON u.id = r.user_id
             WHERE r.id = :id`,
            { id },
        );
        return row ? mapReview(row) : null;
    },

    /** The review a given user left for an entity, if any. */
    async findByUserAndEntity(userId, entityType, entityId) {
        const row = await queryOne(
            `SELECT r.*, u.email AS guest_email,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name
             FROM reviews r
             LEFT JOIN users u ON u.id = r.user_id
             WHERE r.user_id = :userId AND r.entity_type = :entityType
               AND ((:entityId IS NULL AND r.entity_id IS NULL) OR r.entity_id = :entityId)`,
            { userId, entityType, entityId: entityId ?? null },
        );
        return row ? mapReview(row) : null;
    },

    async create({ userId, entityType, entityId, rating, title, comment }) {
        const result = await execute(
            `INSERT INTO reviews (user_id, entity_type, entity_id, rating, title, comment)
             VALUES (:userId, :entityType, :entityId, :rating, :title, :comment)`,
            {
                userId,
                entityType,
                entityId: entityId ?? null,
                rating,
                title,
                comment,
            },
        );
        return result.insertId;
    },

    /** Staff reply, which is public and timestamped. */
    async reply(id, staffReply) {
        const result = await execute(
            'UPDATE reviews SET staff_reply = :staffReply, replied_at = NOW() WHERE id = :id',
            { id, staffReply },
        );
        return result.affectedRows > 0;
    },

    async setVisibility(id, isVisible) {
        const result = await execute('UPDATE reviews SET is_visible = :isVisible WHERE id = :id', {
            id,
            isVisible: isVisible ? 1 : 0,
        });
        return result.affectedRows > 0;
    },

    async setFlagged(id, isFlagged) {
        const result = await execute('UPDATE reviews SET is_flagged = :isFlagged WHERE id = :id', {
            id,
            isFlagged: isFlagged ? 1 : 0,
        });
        return result.affectedRows > 0;
    },

    async remove(id) {
        const result = await execute('DELETE FROM reviews WHERE id = :id', { id });
        return result.affectedRows > 0;
    },
};

export default reviewRepository;
