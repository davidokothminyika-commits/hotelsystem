/**
 * src/repositories/notification.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for the `notifications` table.
 *
 * WHY IT EXISTS
 * Notifications are read far more often than written (the bell is polled on
 * every page load), so the unread query is the one that matters most for
 * performance. It is indexed by (user_id, is_read, created_at).
 *
 * COMMUNICATION
 * Called by: services/notification.service.js
 * Database tables used: notifications
 */
import { query, queryOne, execute } from '../config/db.js';
import { parseJsonColumn } from '../utils/json.js';
import { resolvePagination } from './base.repository.js';

function mapNotification(row) {
    // Shared helper so an already-parsed JSON column is not parsed twice.
    const data = parseJsonColumn(row.data, null);
    return {
        id: row.id,
        userId: row.user_id,
        type: row.type,
        title: row.title,
        body: row.body,
        data,
        isRead: Boolean(row.is_read),
        readAt: row.read_at,
        createdAt: row.created_at,
    };
}

const notificationRepository = {
    async create({ userId, type, title, body, data }) {
        const result = await execute(
            `INSERT INTO notifications (user_id, type, title, body, data)
             VALUES (:userId, :type, :title, :body, :data)`,
            {
                userId,
                type,
                title,
                body: body || null,
                data: data ? JSON.stringify(data) : null,
            },
        );
        return result.insertId;
    },

    /** Paginated list, newest first. */
    async findMany({ page = 1, limit = 20, userId, unreadOnly }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = ['user_id = :userId'];
        const params = { userId, limit: pagination.limit, offset: pagination.offset };

        if (unreadOnly) conditions.push('is_read = 0');

        const where = conditions.join(' AND ');

        const rows = await query(
            `SELECT * FROM notifications WHERE ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT :limit OFFSET :offset`,
            params,
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
            { userId },
        );

        return { rows: rows.map(mapNotification), total: countRow ? Number(countRow.total) : 0 };
    },

    /** Unread count for the header bell badge. */
    async countUnread(userId) {
        const row = await queryOne(
            'SELECT COUNT(*) AS total FROM notifications WHERE user_id = :userId AND is_read = 0',
            { userId },
        );
        return row ? Number(row.total) : 0;
    },

    async findById(id, userId) {
        const row = await queryOne(
            'SELECT * FROM notifications WHERE id = :id AND user_id = :userId',
            { id, userId },
        );
        return row ? mapNotification(row) : null;
    },

    async markAsRead(id, userId) {
        const result = await execute(
            'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = :id AND user_id = :userId',
            { id, userId },
        );
        return result.affectedRows > 0;
    },

    async markAllAsRead(userId) {
        const result = await execute(
            'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = :userId AND is_read = 0',
            { userId },
        );
        return result.affectedRows;
    },

    async remove(id, userId) {
        const result = await execute('DELETE FROM notifications WHERE id = :id AND user_id = :userId', {
            id,
            userId,
        });
        return result.affectedRows > 0;
    },

    async clearAll(userId) {
        const result = await execute('DELETE FROM notifications WHERE user_id = :userId', { userId });
        return result.affectedRows;
    },

    /**
     * Deletes notifications older than a cutoff. Used by a maintenance job so
     * the table does not grow without bound.
     */
    async purgeOlderThan(cutoff) {
        const result = await execute('DELETE FROM notifications WHERE created_at < :cutoff', { cutoff });
        return result.affectedRows;
    },
};

export default notificationRepository;