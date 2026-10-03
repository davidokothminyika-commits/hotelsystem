/**
 * src/controllers/message.controller.js
 *
 * WHAT THIS MODULE DOES
 * Translates messaging HTTP requests into message service calls.
 *
 * WHY IT EXISTS
 * Keeps HTTP concerns out of the service. The guest-versus-staff distinction
 * is decided in the service, so this file only moves data.
 *
 * EVERY HANDLER IS WRAPPED IN asyncHandler
 * Express 4 does not catch rejected promises from async handlers, so an
 * unwrapped throw escapes the router and hangs the request.
 *
 * COMMUNICATION
 * Browser -> /api/messages -> THIS FILE -> services/message.service.js
 * Database tables used: none (the service owns persistence).
 */
import messageService from '../services/message.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';

const messageController = {
    /** GET /api/messages */
    listMine: asyncHandler(async (req, res) => {
        const result = await messageService.listMine(
            { includeClosed: req.query.includeClosed },
            req.user,
        );
        sendSuccess(res, 'Conversations retrieved', result);
    }),

    /** GET /api/messages/inbox */
    listForStaff: asyncHandler(async (req, res) => {
        const result = await messageService.listForStaff({
            page: req.query.page,
            limit: req.query.limit,
            includeClosed: req.query.includeClosed,
            search: req.query.search,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Conversations retrieved',
        );
    }),

    /** GET /api/messages/unread-count */
    unreadCount: asyncHandler(async (req, res) => {
        const result = await messageService.listMine({ includeClosed: false }, req.user);
        sendSuccess(res, 'Unread count retrieved', { unread: result.unread });
    }),

    /** GET /api/messages/:id */
    getOne: asyncHandler(async (req, res) => {
        const result = await messageService.getConversation(req.params.id, req.user);
        sendSuccess(res, 'Conversation retrieved', result);
    }),

    /** POST /api/messages */
    create: asyncHandler(async (req, res) => {
        const result = await messageService.createConversation(
            {
                subject: req.body.subject,
                contextType: req.body.contextType,
                recipientIds: req.body.recipientIds,
            },
            req.user,
        );
        sendCreated(res, 'Conversation started', result);
    }),

    /** POST /api/messages/:id/messages */
    send: asyncHandler(async (req, res) => {
        const message = await messageService.sendMessage(req.params.id, req.body.body, req.user);
        sendCreated(res, 'Message sent', { message });
    }),

    /** PATCH /api/messages/:id/close */
    setClosed: asyncHandler(async (req, res) => {
        const result = await messageService.setClosed(
            req.params.id,
            Boolean(req.body.isClosed),
            req.user,
        );
        sendSuccess(res, result.isClosed ? 'Conversation closed' : 'Conversation reopened', result);
    }),
};

export default messageController;
