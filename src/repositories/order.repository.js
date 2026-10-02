/**
 * src/repositories/order.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for restaurant orders and their line items.
 *
 * WHY IT EXISTS
 * Order creation must be atomic: the order header and its items either both
 * exist or neither does. Writing them in a transaction is what prevents a
 * half-created order reaching the kitchen.
 *
 * COMMUNICATION
 * Called by: services/order.service.js
 * Database tables used: orders, order_items, menu_items, users, rooms, bookings
 * Frontend access: /api/orders
 */
import { query, queryOne } from '../config/db.js';
import { resolvePagination, resolveSort } from './base.repository.js';

/**
 * Valid order transitions.
 *
 * An order can only move forward through this list. Enforcing it in the
 * repository means a kitchen mistake (sending a delivered order back to
 * "preparing") is rejected rather than silently corrupting the workflow.
 */
export const ORDER_TRANSITIONS = Object.freeze({
    pending: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['out_for_delivery', 'delivered', 'cancelled'],
    out_for_delivery: ['delivered', 'cancelled'],
    delivered: [],
    cancelled: [],
});

export function canTransition(from, to) {
    return (ORDER_TRANSITIONS[from] || []).includes(to);
}

const SORTABLE_ORDER_COLUMNS = ['o.placed_at', 'o.total_amount', 'o.status'];

function mapOrder(row, items = null) {
    if (!row) return null;
    const order = {
        id: row.id,
        orderReference: row.order_reference,
        userId: row.user_id,
        roomId: row.room_id,
        bookingId: row.booking_id,
        fulfilmentType: row.fulfilment_type,
        status: row.status,
        subtotal: Number(row.subtotal),
        taxAmount: Number(row.tax_amount),
        serviceCharge: Number(row.service_charge),
        totalAmount: Number(row.total_amount),
        amountPaid: Number(row.amount_paid),
        balanceDue: Number(row.total_amount) - Number(row.amount_paid),
        specialRequests: row.special_requests,
        deliveryNotes: row.delivery_notes,
        placedAt: row.placed_at,
        readyAt: row.ready_at,
        deliveredAt: row.delivered_at,
        cancelledAt: row.cancelled_at,
        createdAt: row.created_at,
        // Joined display fields.
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        roomNumber: row.room_number,
    };

    if (items) {
        order.items = items.map((item) => ({
            id: item.id,
            menuItemId: item.menu_item_id,
            name: item.item_name,
            unitPrice: Number(item.unit_price),
            quantity: item.quantity,
            lineTotal: Number(item.line_total),
            specialInstructions: item.special_instructions,
        }));
    }

    return order;
}

const orderRepository = {
    /**
     * Creates an order and its items inside one transaction.
     *
     * WHY A TRANSACTION
     * The header carries the total and the items carry the detail. If the item
     * insert failed after the header was written, the kitchen would see an
     * order with no food on it and the guest would be charged for nothing.
     *
     * The prices passed in were already resolved from the database by the
     * service, never taken from the request, so a client cannot set its own
     * prices.
     */
    async createWithItems(connection, { order, items }) {
        const [result] = await connection.execute(
            `INSERT INTO orders
               (order_reference, user_id, room_id, booking_id, fulfilment_type, status,
                subtotal, tax_amount, service_charge, total_amount, special_requests, delivery_notes)
             VALUES
               (:orderReference, :userId, :roomId, :bookingId, :fulfilmentType, 'pending',
                :subtotal, :taxAmount, :serviceCharge, :totalAmount, :specialRequests, :deliveryNotes)`,
            order,
        );

        const orderId = result.insertId;

        for (const item of items) {
            await connection.execute(
                `INSERT INTO order_items
                   (order_id, menu_item_id, item_name, unit_price, quantity, line_total, special_instructions)
                 VALUES
                   (:orderId, :menuItemId, :itemName, :unitPrice, :quantity, :lineTotal, :specialInstructions)`,
                { orderId, ...item },
            );
        }

        return orderId;
    },

    async findById(id) {
        const row = await queryOne(
            `SELECT o.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number
             FROM orders o
             JOIN users u ON u.id = o.user_id
             LEFT JOIN rooms r ON r.id = o.room_id
             WHERE o.id = :id`,
            { id },
        );
        if (!row) return null;

        const items = await query(
            'SELECT * FROM order_items WHERE order_id = :orderId ORDER BY id ASC',
            { orderId: id },
        );

        return mapOrder(row, items);
    },

    async findByReference(reference) {
        const row = await queryOne('SELECT id FROM orders WHERE order_reference = :reference', { reference });
        return row ? this.findById(row.id) : null;
    },

    /**
     * Paginated order list.
     *
     * Staff see every order; a guest's query is scoped by userId. The kitchen
     * board filters by status, which is the column it sorts and groups on.
     */
    async findMany({ page = 1, limit = 20, userId, status, search, roomId, fulfilmentType, sortBy, sortDir, startDate, endDate }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = { limit: pagination.limit, offset: pagination.offset };

        if (userId) {
            conditions.push({ sql: 'o.user_id = :userId', params: { userId } });
        }
        if (roomId) {
            conditions.push({ sql: 'o.room_id = :roomId', params: { roomId } });
        }
        if (fulfilmentType) {
            conditions.push({ sql: 'o.fulfilment_type = :fulfilmentType', params: { fulfilmentType } });
        }
        if (status) {
            const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
            if (statuses.length > 0) {
                const placeholders = statuses.map((_, index) => `:status${index}`).join(', ');
                conditions.push({
                    sql: `o.status IN (${placeholders})`,
                    params: Object.fromEntries(statuses.map((value, index) => [`status${index}`, value])),
                });
            }
        }
        if (search) {
            conditions.push({
                sql: '(o.order_reference LIKE :search OR u.first_name LIKE :search OR u.last_name LIKE :search OR r.room_number LIKE :search)',
                params: { search: `%${search}%` },
            });
        }
        if (startDate) {
            conditions.push({ sql: 'o.placed_at >= :startDate', params: { startDate } });
        }
        if (endDate) {
            conditions.push({ sql: 'o.placed_at <= :endDate', params: { endDate } });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        // Newest first: the kitchen cares about what arrived most recently.
        const sort = resolveSort(sortBy, sortDir, SORTABLE_ORDER_COLUMNS, 'o.placed_at', 'DESC');

        const rows = await query(
            `SELECT o.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.email AS guest_email,
                    r.room_number
             FROM orders o
             JOIN users u ON u.id = o.user_id
             LEFT JOIN rooms r ON r.id = o.room_id
             ${where}
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM orders o
             JOIN users u ON u.id = o.user_id
             LEFT JOIN rooms r ON r.id = o.room_id
             ${where}`,
            filterParams,
        );

        return { rows: rows.map((row) => mapOrder(row)), total: countRow ? Number(countRow.total) : 0 };
    },

    /**
     * Moves an order to a new status, recording the relevant timestamp.
     *
     * The caller has already validated the transition with canTransition.
     */
    async updateStatus(id, status) {
        const timestampColumn =
            status === 'ready'
                ? 'ready_at'
                : status === 'delivered'
                  ? 'delivered_at'
                  : status === 'cancelled'
                    ? 'cancelled_at'
                    : null;

        const extra = timestampColumn ? `, ${timestampColumn} = NOW()` : '';

        await queryOne(
            `UPDATE orders SET status = :status${extra} WHERE id = :id`,
            { id, status },
        );

        return this.findById(id);
    },

    /** Updates amount paid, used by the payment service. */
    async addPaymentAmount(id, amount, connection = null) {
        const sql = 'UPDATE orders SET amount_paid = amount_paid + :amount WHERE id = :id';
        if (connection) {
            await connection.execute(sql, { id, amount });
        } else {
            await queryOne(sql, { id, amount });
        }
    },

    /** Generates a unique human readable order reference. */
    async generateReference() {
        // Same 12 character format as a booking reference: 'OR' plus 10
        // unambiguous uppercase characters, matching CHAR(12).
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const timestamp = Date.now().toString(36).toUpperCase().padStart(6, '0').slice(-6);
            let random = '';
            for (let i = 0; i < 4; i += 1) {
                random += alphabet[Math.floor(Math.random() * alphabet.length)];
            }

            const reference = `OR${timestamp}${random}`;

            const existing = await queryOne('SELECT id FROM orders WHERE order_reference = :reference', { reference });
            if (!existing) return reference;
        }

        throw new Error('Unable to generate a unique order reference');
    },

    /** Counts per status, for the kitchen board columns. */
    async getStatusCounts() {
        const rows = await query('SELECT status, COUNT(*) AS total FROM orders GROUP BY status');
        const counts = {
            pending: 0, confirmed: 0, preparing: 0, ready: 0,
            out_for_delivery: 0, delivered: 0, cancelled: 0,
        };
        for (const row of rows) counts[row.status] = Number(row.total);
        counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
        counts.active = counts.total - counts.delivered - counts.cancelled;
        return counts;
    },

    /** Orders that have not yet reached a terminal state, for the board. */
    async getActiveOrders() {
        const rows = await query(
            `SELECT o.*,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name,
                    u.phone, r.room_number
             FROM orders o
             JOIN users u ON u.id = o.user_id
             LEFT JOIN rooms r ON r.id = o.room_id
             WHERE o.status NOT IN ('delivered', 'cancelled')
             ORDER BY FIELD(o.status, 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'), o.placed_at ASC`,
        );

        const orders = [];

        for (const row of rows) {
            const items = await query(
                'SELECT * FROM order_items WHERE order_id = :orderId ORDER BY id ASC',
                { orderId: row.id },
            );
            orders.push(mapOrder(row, items));
        }

        return orders;
    },

    /** Restaurant sales figures for the reports screen. */
    async getSalesSummary({ startDate, endDate }) {
        const conditions = ["status NOT IN ('cancelled')"];
        const params = {};

        if (startDate) {
            conditions.push('placed_at >= :startDate');
            params.startDate = startDate;
        }
        if (endDate) {
            conditions.push('placed_at <= :endDate');
            params.endDate = endDate;
        }

        const row = await queryOne(
            `SELECT COUNT(*) AS total_orders,
                    COALESCE(SUM(total_amount), 0) AS revenue,
                    COALESCE(AVG(total_amount), 0) AS average_order
             FROM orders
             WHERE ${conditions.join(' AND ')}`,
            params,
        );

        const byMethod = await query(
            `SELECT fulfilment_type, COUNT(*) AS total
             FROM orders
             WHERE ${conditions.join(' AND ')}
             GROUP BY fulfilment_type`,
            params,
        );

        return {
            totalOrders: Number(row?.total_orders || 0),
            revenue: Number(row?.revenue || 0),
            averageOrder: Number(row?.average_order || 0),
            byFulfilment: byMethod.map((entry) => ({
                type: entry.fulfilment_type,
                count: Number(entry.total),
            })),
        };
    },
};

export default orderRepository;