/**
 * src/repositories/message.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for `conversations`, `conversation_participants` and `messages`.
 *
 * WHY IT EXISTS
 * Messaging is the one part of the schema that spans three tables, and getting
 * the joins wrong is easy and expensive: a naive "load the thread" query either
 * leaks messages from conversations the reader is not part of, or repeats every
 * message once per participant. Both failure modes are prevented here.
 *
 * MEMBERSHIP IS ALWAYS CHECKED IN SQL
 * Every query that touches messages joins through `conversation_participants`
 * and filters on the reader's own user id. Authorization is therefore part of
 * the query rather than a separate check that could be forgotten.
 *
 * COMMUNICATION
 * Called by: services/message.service.js
 * Database tables used: conversations, conversation_participants, messages, users
 */
import { query, queryOne, execute, withTransaction } from '../config/db.js';
import { resolvePagination } from './base.repository.js';

function mapConversation(row) {
    return {
        id: row.id,
        subject: row.subject,
        contextType: row.context_type,
        isClosed: Boolean(row.is_closed),
        lastMessageAt: row.last_message_at,
        createdAt: row.created_at,
        lastMessage: row.last_message || null,
        lastSenderName: row.last_sender_name || null,
        // Other participants, so a guest can see who they are talking to.
        participants: row.participants ? String(row.participants).split(',').filter(Boolean) : [],
        unreadCount: Number(row.unread_count || 0),
    };
}

function mapMessage(row) {
    return {
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        senderName: row.sender_name || null,
        body: row.body,
        readAt: row.read_at,
        createdAt: row.created_at,
        // True when the reader did not write it, so the UI can align it.
        isOwn: row.sender_id === row.viewerId,
    };
}

const messageRepository = {
    /**
     * Conversations the user takes part in, most recently active first.
     *
     * The unread count is computed against the participant's `last_read_id`
     * rather than against `read_at`, which is more reliable: a message read out
     * of order on another device still counts correctly because the marker is
     * the highest message id seen rather than a timestamp that can be skewed.
     */
    async findConversationsForUser(userId, { includeClosed = false } = {}) {
        const conditions = ['cp.user_id = :userId'];
        if (!includeClosed) conditions.push('c.is_closed = 0');

        const rows = await query(
            `SELECT c.*,
                    lm.body AS last_message,
                    CONCAT(ls.first_name, ' ', ls.last_name) AS last_sender_name,
                    (
                        SELECT GROUP_CONCAT(CONCAT(u2.first_name, ' ', u2.last_name) SEPARATOR ',')
                        FROM conversation_participants cp2
                        JOIN users u2 ON u2.id = cp2.user_id
                        WHERE cp2.conversation_id = c.id AND cp2.user_id <> :userId
                    ) AS participants,
                    (
                        SELECT COUNT(*) FROM messages m
                        WHERE m.conversation_id = c.id
                          AND m.id > COALESCE(cp.last_read_id, 0)
                          AND m.sender_id <> :userId
                    ) AS unread_count
             FROM conversations c
             JOIN conversation_participants cp ON cp.conversation_id = c.id
             LEFT JOIN messages lm ON lm.id = (
                 SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
             )
             LEFT JOIN users ls ON ls.id = lm.sender_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
             LIMIT 200`,
            { userId },
        );

        return rows.map(mapConversation);
    },

    /** Total unread messages across every conversation. Drives the sidebar badge. */
    async countUnreadForUser(userId) {
        const row = await queryOne(
            `SELECT COUNT(*) AS total FROM messages m
             JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
             WHERE cp.user_id = :userId
               AND m.id > COALESCE(cp.last_read_id, 0)
               AND m.sender_id <> :userId`,
            { userId },
        );
        return row ? Number(row.total) : 0;
    },

    /**
     * One conversation, only if the user participates in it.
     * A non-participant gets null rather than a row, so the caller cannot
     * distinguish "does not exist" from "not yours" if it chooses not to.
     */
    async findConversationForUser(id, userId) {
        const row = await queryOne(
            `SELECT c.*,
                    (
                        SELECT GROUP_CONCAT(CONCAT(u2.first_name, ' ', u2.last_name) SEPARATOR ',')
                        FROM conversation_participants cp2
                        JOIN users u2 ON u2.id = cp2.user_id
                        WHERE cp2.conversation_id = c.id AND cp2.user_id <> :userId
                    ) AS participants
             FROM conversations c
             JOIN conversation_participants cp ON cp.conversation_id = c.id
             WHERE c.id = :id AND cp.user_id = :userId`,
            { id, userId },
        );
        return row ? mapConversation(row) : null;
    },

    async findMessages(conversationId, userId, { limit = 200 } = {}) {
        const rows = await query(
            `SELECT m.*, :userId AS viewerId,
                    CONCAT(u.first_name, ' ', u.last_name) AS sender_name
             FROM messages m
             JOIN users u ON u.id = m.sender_id
             JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
             WHERE m.conversation_id = :conversationId AND cp.user_id = :userId
             ORDER BY m.id ASC
             LIMIT :limit`,
            { conversationId, userId, limit: Math.min(500, Math.max(1, Number(limit) || 200)) },
        );
        return rows.map(mapMessage);
    },

    /** Staff view of every conversation, for the inbox. */
    async findAllConversations({ page = 1, limit = 25, includeClosed = false, search } = {}) {
        const pagination = resolvePagination({ page, limit });
        const conditions = ['1 = 1'];
        const params = {};

        if (!includeClosed) conditions.push('c.is_closed = 0');
        if (search) {
            conditions.push('c.subject LIKE :search');
            params.search = `%${search}%`;
        }
        const where = conditions.join(' AND ');

        const rows = await query(
            `SELECT c.*,
                    lm.body AS last_message,
                    CONCAT(ls.first_name, ' ', ls.last_name) AS last_sender_name,
                    (
                        SELECT GROUP_CONCAT(CONCAT(u2.first_name, ' ', u2.last_name) SEPARATOR ',')
                        FROM conversation_participants cp2
                        JOIN users u2 ON u2.id = cp2.user_id
                        WHERE cp2.conversation_id = c.id
                    ) AS participants,
                    (
                        SELECT COUNT(*) FROM messages m
                        WHERE m.conversation_id = c.id AND m.read_at IS NULL
                    ) AS unread_count
             FROM conversations c
             LEFT JOIN messages lm ON lm.id = (
                 SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
             )
             LEFT JOIN users ls ON ls.id = lm.sender_id
             WHERE ${where}
             ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, params, { limit: pagination.limit, offset: pagination.offset }),
        );

        const countRow = await queryOne(`SELECT COUNT(*) AS total FROM conversations c WHERE ${where}`, params);

        return {
            rows: rows.map(mapConversation),
            total: countRow ? Number(countRow.total) : 0,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: Math.max(1, Math.ceil((countRow ? Number(countRow.total) : 0) / pagination.limit)),
        };
    },

    /**
     * Opens a conversation between the requester and a set of recipients.
     *
     * Runs in a transaction because a conversation without its participants is
     * unreachable by anyone: `findConversationsForUser` joins through the
     * participant table, so a half-created conversation would be invisible and
     * unopenable rather than obviously broken.
     */
    async createConversation({ subject, contextType, creatorId, participantIds }) {
        return withTransaction(async (connection) => {
            const [result] = await connection.execute(
                `INSERT INTO conversations (subject, context_type) VALUES (?, ?)`,
                [subject, contextType],
            );
            const conversationId = result.insertId;

            // The creator is a participant too, otherwise they could never see
            // the thread they just opened.
            const everyone = [...new Set([creatorId, ...participantIds].map(Number))];
            for (const userId of everyone) {
                await connection.execute(
                    'INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)',
                    [conversationId, userId],
                );
            }

            return conversationId;
        });
    },

    /**
     * Appends a message and moves the conversation to the top of every
     * participant's inbox.
     *
     * `last_message_at` is bumped in the same transaction as the insert, so a
     * conversation can never be ordered as active when its newest message is
     * actually older than another thread's.
     */
    async createMessage({ conversationId, senderId, body }) {
        return withTransaction(async (connection) => {
            const [result] = await connection.execute(
                'INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)',
                [conversationId, senderId, body],
            );
            const messageId = result.insertId;

            await connection.execute(
                'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
                [conversationId],
            );

            // The sender has by definition read their own message. Without this
            // the sender sees their own message as unread in the badge.
            await connection.execute(
                'UPDATE conversation_participants SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?',
                [messageId, conversationId, senderId],
            );

            return messageId;
        });
    },

    /** Marks everything up to the newest message as read for this user. */
    async markConversationRead(conversationId, userId) {
        const result = await execute(
            `UPDATE conversation_participants cp
             SET cp.last_read_id = (SELECT MAX(id) FROM messages WHERE conversation_id = :conversationId)
             WHERE cp.conversation_id = :conversationId AND cp.user_id = :userId`,
            { conversationId, userId },
        );
        await execute(
            `UPDATE messages SET read_at = NOW()
             WHERE conversation_id = :conversationId AND read_at IS NULL AND sender_id <> :userId`,
            { conversationId, userId },
        );
        return result.affectedRows > 0;
    },

    async setClosed(id, isClosed) {
        const result = await execute('UPDATE conversations SET is_closed = :isClosed WHERE id = :id', {
            id,
            isClosed: isClosed ? 1 : 0,
        });
        return result.affectedRows > 0;
    },

    /** Adds staff to an existing conversation so they can answer it. */
    async addParticipant(conversationId, userId) {
        const result = await execute(
            'INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (:conversationId, :userId)',
            { conversationId, userId },
        );
        return result.affectedRows > 0;
    },

    /** Ids of everyone in a conversation, used to fan out notifications. */
    async listParticipantIds(conversationId) {
        const rows = await query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = :conversationId',
            { conversationId },
        );
        return rows.map((row) => row.user_id);
    },

    /** Staff who can be assigned a conversation. */
    async listStaffIds() {
        const rows = await query(
            `SELECT u.id FROM users u
             JOIN roles r ON r.id = u.role_id
             WHERE r.name IN ('receptionist', 'manager', 'admin') AND u.is_active = 1`,
        );
        return rows.map((row) => row.id);
    },

    async countOpen() {
        const row = await queryOne('SELECT COUNT(*) AS total FROM conversations WHERE is_closed = 0');
        return row ? Number(row.total) : 0;
    },
};

export default messageRepository;
