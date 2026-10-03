/**
 * src/controllers/notification.controller.js
 *
 * WHAT THIS MODULE DOES
 * Exposes the signed in user's own notifications.
 *
 * WHY IT EXISTS
 * The header bell polls this on every page load, so it is the most frequently
 * requested endpoint in the application and is deliberately scoped to one user.
 * There is no endpoint that returns another user's notifications, which is why
 * `userId` is taken from the session and never from the query string.
 *
 * EVERY HANDLER IS WRAPPED IN asyncHandler
 * Express 4 does not catch rejected promises from async handlers, so an
 * unwrapped throw escapes the router and hangs the request.
 *
 * COMMUNICATION
 * Browser -> /api/notifications -> THIS FILE -> services/notification.service.js
 * Database tables used: none (the service owns persistence).
 */
import notificationService from '../services/notification.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { sendSuccess, sendPaginated } from '../utils/response.js';

const notificationController = {
    /** GET /api/notifications */
    list: asyncHandler(async (req, res) => {
        const result = await notificationService.list({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            unreadOnly: req.query.unreadOnly,
        });

        // The repository returns { rows, total }; the envelope and the unread
        // count are added here so the bell can refresh itself from one call.
        return sendPaginated(res, result.rows, { total: result.total }, 'Notifications retrieved');
    }),

    /** GET /api/notifications/unread-count */
    unreadCount: asyncHandler(async (req, res) => {
        const unread = await notificationService.countUnread(req.user.id);
        sendSuccess(res, 'Unread count retrieved', { unread });
    }),

    /** PATCH /api/notifications/:id/read */
    markAsRead: asyncHandler(async (req, res) => {
        const updated = await notificationService.markAsRead(req.params.id, req.user.id);
        if (!updated) {
            sendSuccess(res, 'Notification not found or already read', { updated: false });
            return;
        }
        const unread = await notificationService.countUnread(req.user.id);
        sendSuccess(res, 'Marked as read', { updated: true, unread });
    }),

    /** PATCH /api/notifications/read-all */
    markAllAsRead: asyncHandler(async (req, res) => {
        const updated = await notificationService.markAllAsRead(req.user.id);
        sendSuccess(res, 'All notifications marked as read', { updated, unread: 0 });
    }),

    /** DELETE /api/notifications/:id */
    remove: asyncHandler(async (req, res) => {
        await notificationService.remove(req.params.id, req.user.id);
        sendSuccess(res, 'Notification removed');
    }),

    /** DELETE /api/notifications */
    clearAll: asyncHandler(async (req, res) => {
        const removed = await notificationService.clearAll(req.user.id);
        sendSuccess(res, 'Notifications cleared', { removed });
    }),
};

export default notificationController;
