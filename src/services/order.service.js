/**
 * src/services/order.service.js
 *
 * WHAT THIS MODULE DOES
 * Food ordering: cart pricing, order placement, the kitchen workflow and
 * order cancellation.
 *
 * WHY IT EXISTS
 * Two rules make this more than a thin wrapper around the database:
 *
 *   1. PRICING IS NEVER TRUSTED FROM THE CLIENT. The request carries only
 *      item ids and quantities. Prices are read from `menu_items` and every
 *      total is computed on the server. A client that posts its own prices is
 *      simply ignored, so editing the request in devtools cannot buy a
 *      hundred-dollar dinner for one dollar.
 *
 *   2. ROOM DELIVERY REQUIRES A REAL STAY. Delivery to a room is only
 *      offered when the guest has an active booking, so an order cannot be
 *      placed for a room nobody is in.
 *
 * COMMUNICATION
 * Browser -> /api/orders -> orders.controller.js -> THIS FILE
 *        -> order.repository.js, menu.repository.js, booking.repository.js,
 *           notification.service.js
 * Database tables used: orders, order_items, menu_items, bookings, rooms, users
 */
import ApiError from '../utils/errors.js';
import { withTransaction } from '../config/db.js';
import { calculateTotals, PRICING } from '../config/pricing.js';
import orderRepository from '../repositories/order.repository.js';
// canTransition is a named export from the repository, alongside the
// ORDER_TRANSITIONS table it reads. It is not on the default export object.
import { canTransition } from '../repositories/order.repository.js';
import menuRepository from '../repositories/menu.repository.js';
import bookingRepository from '../repositories/booking.repository.js';
import notificationService from './notification.service.js';

/** Maximum quantity of one item per order, to stop runaway carts. */
const MAX_ITEM_QUANTITY = 20;
/** Maximum distinct lines in a single order. */
const MAX_ORDER_LINES = 30;

const orderService = {
    /**
     * Places an order.
     *
     * @param {object} input
     * @param {number} input.userId
     * @param {Array<{menuItemId:number, quantity:number, specialInstructions?:string}>} input.items
     * @param {'room_delivery'|'restaurant_pickup'} input.fulfilmentType
     * @param {number} [input.roomId]   Required for room delivery.
     * @param {number} [input.bookingId] Validates the guest's stay.
     */
    async placeOrder({ userId, items, fulfilmentType, roomId, bookingId, specialRequests, deliveryNotes }) {
        if (!Array.isArray(items) || items.length === 0) {
            throw ApiError.badRequest('Your order is empty', 'EMPTY_ORDER');
        }
        if (items.length > MAX_ORDER_LINES) {
            throw ApiError.badRequest(`An order may contain at most ${MAX_ORDER_LINES} different items`, 'ORDER_TOO_LARGE');
        }

        // ---- Validate the requested quantities ----
        const requested = new Map();
        for (const item of items) {
            const id = Number(item.menuItemId);
            const quantity = Number(item.quantity);

            if (!Number.isInteger(id) || id < 1) {
                throw ApiError.badRequest('An order line references an invalid item', 'INVALID_ITEM');
            }
            if (!Number.isInteger(quantity) || quantity < 1) {
                throw ApiError.badRequest('Quantities must be whole numbers of at least one', 'INVALID_QUANTITY');
            }
            if (quantity > MAX_ITEM_QUANTITY) {
                throw ApiError.badRequest(
                    `Maximum ${MAX_ITEM_QUANTITY} of any one item per order`,
                    'QUANTITY_TOO_HIGH',
                );
            }

            // Merging duplicates prevents a client from sending the same item
            // twice to bypass the per-line quantity cap.
            requested.set(id, (requested.get(id) || 0) + quantity);
        }

        for (const [, quantity] of requested) {
            if (quantity > MAX_ITEM_QUANTITY) {
                throw ApiError.badRequest(
                    `Maximum ${MAX_ITEM_QUANTITY} of any one item per order`,
                    'QUANTITY_TOO_HIGH',
                );
            }
        }

        // ---- Resolve prices from the database ----
        const menuItems = await menuRepository.findItemsByIds([...requested.keys()]);
        const byId = new Map(menuItems.map((item) => [item.id, item]));

        const instructionsByItem = new Map(
            items.map((item) => [Number(item.menuItemId), item.specialInstructions]),
        );

        const orderItems = [];
        for (const [id, quantity] of requested) {
            const menuItem = byId.get(id);

            if (!menuItem) {
                throw ApiError.notFound(`Menu item ${id} no longer exists`, 'ITEM_NOT_FOUND');
            }
            if (!menuItem.isAvailable) {
                throw ApiError.badRequest(`${menuItem.name} is sold out`, 'ITEM_UNAVAILABLE');
            }

            // unit_price comes from the database record, never the request.
            const lineTotal = Number((menuItem.price * quantity).toFixed(2));

            orderItems.push({
                menuItemId: menuItem.id,
                itemName: menuItem.name,
                unitPrice: menuItem.price,
                quantity,
                lineTotal,
                specialInstructions: instructionsByItem.get(id)
                    ? String(instructionsByItem.get(id)).slice(0, 255)
                    : null,
            });
        }

        const subtotal = Number(orderItems.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
        const totals = calculateTotals(subtotal);

        // ---- Validate fulfilment ----
        let resolvedRoomId = null;
        let resolvedBookingId = null;

        if (fulfilmentType === 'room_delivery') {
            if (!roomId) {
                throw ApiError.badRequest('Choose a room for delivery', 'ROOM_REQUIRED');
            }

            // The guest must actually be staying in that room. This is what
            // stops an order being delivered to an occupied room by someone
            // who is not the guest.
            const booking = await this.findActiveBookingForRoom(userId, roomId);

            if (!booking) {
                throw ApiError.badRequest(
                    'Room delivery is only available for rooms you are currently staying in',
                    'NO_ACTIVE_STAY',
                );
            }

            resolvedRoomId = Number(roomId);
            resolvedBookingId = booking.id;
        }

        // ---- Create the order atomically ----
        const reference = await orderRepository.generateReference();

        const orderId = await withTransaction(async (connection) => {
            const id = await orderRepository.createWithItems(connection, {
                order: {
                    orderReference: reference,
                    userId,
                    roomId: resolvedRoomId,
                    bookingId: resolvedBookingId,
                    fulfilmentType,
                    subtotal: totals.subtotal,
                    taxAmount: totals.taxAmount,
                    serviceCharge: totals.serviceCharge,
                    totalAmount: totals.totalAmount,
                    specialRequests: specialRequests ? String(specialRequests).slice(0, 1000) : null,
                    deliveryNotes: deliveryNotes ? String(deliveryNotes).slice(0, 255) : null,
                },
                items: orderItems,
            });
            return id;
        });

        const order = await orderRepository.findById(orderId);

        await notificationService.notifyOrderPlaced(order).catch((error) =>
            console.error('[order] Notification failed:', error.message),
        );

        return order;
    },

    /**
     * Finds an active stay for a guest in a room.
     *
     * Delegates to the repository, which resolves "checked in, or arriving
     * today" in one query rather than two round trips.
     */
    async findActiveBookingForRoom(userId, roomId) {
        return bookingRepository.findActiveStayForRoom(userId, roomId);
    },

    /**
     * Lists orders. A guest only ever sees their own.
     */
    async listOrders({ userId, role, page, limit, status, search, fulfilmentType, startDate, endDate }) {
        const isStaff = role !== 'guest';
        return orderRepository.findMany({
            page,
            limit,
            // Staff list every order; a guest's scope is forced to their own
            // id. The ternary is written this way round so it is obvious the
            // guest branch cannot be widened by a caller passing userId.
            userId: isStaff ? undefined : userId,
            status,
            search,
            fulfilmentType,
            startDate,
            endDate,
        });
    },

    /** Single order, enforcing ownership. */
    async getOrder(id, requester) {
        const order = await orderRepository.findById(id);
        if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');

        const isOwner = Number(order.userId) === Number(requester.id);
        if (!isOwner && requester.role === 'guest') {
            // 404 rather than 403, so the endpoint does not confirm it exists.
            throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
        }

        return order;
    },

    /**
     * Advances an order through the kitchen workflow.
     *
     * Transitions are validated against ORDER_TRANSITIONS, so an order cannot
     * jump from "pending" straight to "delivered" or move backwards.
     */
    async updateStatus(id, newStatus, requester) {
        const order = await this.getOrder(id, requester);

        if (order.status === newStatus) {
            throw ApiError.badRequest(`This order is already ${newStatus.replace('_', ' ')}`, 'NO_STATUS_CHANGE');
        }

        if (!canTransition(order.status, newStatus)) {
            throw ApiError.badRequest(
                `An order cannot move from ${order.status.replace('_', ' ')} to ${newStatus.replace('_', ' ')}`,
                'INVALID_STATUS_TRANSITION',
            );
        }

        const updated = await orderRepository.updateStatus(id, newStatus);

        await notificationService.notifyOrderStatusChanged(updated).catch((error) =>
            console.error('[order] Notification failed:', error.message),
        );

        return updated;
    },

    /**
     * Cancels an order.
     *
     * Only before it has been delivered. Once the kitchen has handed it over,
     * the sale has happened and the money side must be settled rather than
     * cancelled.
     */
    async cancelOrder(id, requester, reason) {
        const order = await this.getOrder(id, requester);

        if (order.status === 'cancelled') {
            throw ApiError.badRequest('This order is already cancelled', 'ALREADY_CANCELLED');
        }

        if (['delivered', 'out_for_delivery'].includes(order.status)) {
            throw ApiError.badRequest(
                'An order that has left the kitchen cannot be cancelled. Please speak to reception.',
                'CANNOT_CANCEL',
            );
        }

        const updated = await orderRepository.updateStatus(id, 'cancelled');

        await notificationService.notifyOrderStatusChanged(updated).catch((error) =>
            console.error('[order] Notification failed:', error.message),
        );

        return updated;
    },

    /** Counts per status, for the kitchen board and dashboards. */
    async getStatusCounts() {
        return orderRepository.getStatusCounts();
    },

    /** The active order board used by restaurant staff. */
    async getKitchenBoard() {
        const [orders, counts] = await Promise.all([
            orderRepository.getActiveOrders(),
            orderRepository.getStatusCounts(),
        ]);

        // Grouped into columns so the board renders one list per state.
        return {
            columns: {
                pending: orders.filter((order) => order.status === 'pending'),
                confirmed: orders.filter((order) => order.status === 'confirmed'),
                preparing: orders.filter((order) => order.status === 'preparing'),
                ready: orders.filter((order) => order.status === 'ready'),
                out_for_delivery: orders.filter((order) => order.status === 'out_for_delivery'),
            },
            counts,
        };
    },

    /** Guest dashboard figures. */
    async getGuestSummary(userId) {
        const { rows } = await orderRepository.findMany({ userId, limit: 100 });
        const active = rows.filter((order) => !['delivered', 'cancelled'].includes(order.status));
        const spent = rows
            .filter((order) => order.status !== 'cancelled')
            .reduce((sum, order) => sum + Number(order.totalAmount), 0);

        return {
            totalOrders: rows.length,
            activeOrders: active.length,
            totalSpent: Number(spent.toFixed(2)),
            currency: PRICING.currency,
        };
    },

    async getSalesSummary(options) {
        return orderRepository.getSalesSummary(options);
    },
};

export default orderService;