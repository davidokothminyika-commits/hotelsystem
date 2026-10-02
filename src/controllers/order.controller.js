/**
 * src/controllers/order.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for food orders and the restaurant kitchen workflow.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/order.service.js
 * Frontend: public/js/api/orders.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import orderService from '../services/order.service.js';

const orderController = {
    /**
     * GET /api/orders
     * Staff see every order; a guest sees only their own.
     */
    list: asyncHandler(async (req, res) => {
        const isStaff = req.user.role !== 'guest';

        const result = await orderService.listOrders({
            userId: req.user.id,
            role: req.user.role,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            search: req.query.search,
            fulfilmentType: req.query.fulfilmentType,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: req.query.page || 1, limit: req.query.limit || 20, total: result.total },
            'Orders retrieved',
        );
    }),

    /** POST /api/orders */
    create: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;

        const order = await orderService.placeOrder({
            userId: req.user.id,
            items: payload.items,
            fulfilmentType: payload.fulfilmentType,
            roomId: payload.roomId,
            bookingId: payload.bookingId,
            specialRequests: payload.specialRequests,
            deliveryNotes: payload.deliveryNotes,
        });

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.ORDER_CREATED,
            entity: 'orders',
            entityId: order.id,
            req,
            metadata: {
                reference: order.orderReference,
                total: order.totalAmount,
                fulfilment: order.fulfilmentType,
                lines: order.items?.length || 0,
            },
        });

        return sendCreated(res, `Order ${order.orderReference} placed`, { order });
    }),

    /** GET /api/orders/:id */
    detail: asyncHandler(async (req, res) => {
        const order = await orderService.getOrder(req.params.id, req.user);
        return sendSuccess(res, 'Order retrieved', { order });
    }),

    /** PATCH /api/orders/:id/status (restaurant staff) */
    updateStatus: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const order = await orderService.updateStatus(req.params.id, payload.status, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
            entity: 'orders',
            entityId: order.id,
            req,
            metadata: { status: payload.status, reference: order.orderReference },
        });

        return sendSuccess(res, `Order marked as ${payload.status.replace('_', ' ')}`, { order });
    }),

    /** POST /api/orders/:id/cancel */
    cancel: asyncHandler(async (req, res) => {
        const reason = req.body?.reason;
        const order = await orderService.cancelOrder(req.params.id, req.user, reason);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.ORDER_CANCELLED,
            entity: 'orders',
            entityId: order.id,
            req,
            metadata: { reference: order.orderReference, reason: reason || null },
        });

        return sendSuccess(res, 'Order cancelled', { order });
    }),

    /** GET /api/orders/summary (guest dashboard) */
    summary: asyncHandler(async (req, res) => {
        const summary = await orderService.getGuestSummary(req.user.id);
        return sendSuccess(res, 'Order summary retrieved', { summary });
    }),

    /** GET /api/orders/board (kitchen display) */
    board: asyncHandler(async (req, res) => {
        const board = await orderService.getKitchenBoard();
        return sendSuccess(res, 'Order board retrieved', board);
    }),

    /** GET /api/orders/counts (dashboard cards) */
    counts: asyncHandler(async (req, res) => {
        const counts = await orderService.getStatusCounts();
        return sendSuccess(res, 'Order counts retrieved', { counts });
    }),

    /** GET /api/orders/sales (restaurant revenue) */
    sales: asyncHandler(async (req, res) => {
        const summary = await orderService.getSalesSummary({
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });
        return sendSuccess(res, 'Sales summary retrieved', { summary });
    }),
};

export default orderController;