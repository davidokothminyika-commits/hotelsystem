/**
 * src/repositories/payment.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for payments and invoices.
 *
 * WHY IT EXISTS
 * Recording a payment and issuing the matching invoice must be atomic. If the
 * charge succeeds but the invoice insert fails, the guest has been charged
 * with no receipt, which is the worst outcome in the whole system. Keeping the
 * SQL together lets the service wrap both writes in one transaction.
 *
 * COMMUNICATION
 * Called by: services/payment.service.js
 * Database tables used: payments, invoices, bookings, orders, users, rooms
 * Frontend access: /api/payments, /api/invoices
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolvePagination, resolveSort, buildInClause } from './base.repository.js';
import { parseJsonColumn } from '../utils/json.js';

const SORTABLE_PAYMENT_COLUMNS = ['p.created_at', 'p.amount', 'p.status', 'p.payment_method'];

/** Maps a joined database row onto the shape the API returns. */
function mapPayment(row) {
    if (!row) return null;

    return {
        id: row.id,
        paymentReference: row.payment_reference,
        transactionId: row.transaction_id,
        userId: row.user_id,
        bookingId: row.booking_id,
        orderId: row.order_id,
        amount: Number(row.amount),
        currency: row.currency,
        paymentMethod: row.payment_method,
        status: row.status,
        failureReason: row.failure_reason,
        providerResponse: parseJsonColumn(row.provider_response),
        paidAt: row.paid_at,
        refundedAt: row.refunded_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Joined display fields.
        guestName: row.guest_name,
        bookingReference: row.booking_reference,
        orderReference: row.order_reference,
        invoiceNumber: row.invoice_number,
    };
}

function mapInvoice(row) {
    if (!row) return null;

    return {
        id: row.id,
        invoiceNumber: row.invoice_number,
        bookingId: row.booking_id,
        orderId: row.order_id,
        userId: row.user_id,
        subtotal: Number(row.subtotal),
        taxAmount: Number(row.tax_amount),
        serviceCharge: Number(row.service_charge),
        totalAmount: Number(row.total_amount),
        amountPaid: Number(row.amount_paid),
        balanceDue: Number(row.balance_due),
        status: row.status,
        paymentMethod: row.payment_method,
        paymentReference: row.payment_reference,
        issuedAt: row.issued_at,
        createdAt: row.created_at,
        // Joined display fields.
        guestName: row.guest_name,
        guestEmail: row.guest_email,
        bookingReference: row.booking_reference,
        orderReference: row.order_reference,
        roomNumber: row.room_number,
        checkIn: row.check_in,
        checkOut: row.check_out,
    };
}

/**
 * Generates a human friendly invoice number.
 *
 * The random tail matters because invoices are created inside a transaction
 * that may retry, and two invoices must never collide on the unique key.
 */
function generateInvoiceNumber() {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const tail = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `INV-${stamp}-${tail}`;
}

export const paymentRepository = {
    // ---- Reads -------------------------------------------------------------

    /** Paginated, filterable payment list. */
    async findMany({ page, limit, userId, status, method, search, startDate, endDate, sortBy, sortDir }) {
        // Object form, matching every other repository. Passing positional
        // arguments here silently ignored the caller's `limit` because the
        // helper destructures a single options object.
        const pagination = resolvePagination({ page, limit });
        const sort = resolveSort(sortBy, sortDir, SORTABLE_PAYMENT_COLUMNS, 'p.created_at', 'desc');

        const where = [];
        const params = {};

        if (userId) {
            where.push('p.user_id = :userId');
            params.userId = userId;
        }
        if (status) {
            const { clause, values } = buildInClause('p.status', String(status).split(',').map((s) => s.trim()));
            where.push(clause);
            Object.assign(params, values);
        }
        if (method) {
            where.push('p.payment_method = :method');
            params.method = method;
        }
        if (startDate) {
            where.push('p.created_at >= :startDate');
            params.startDate = startDate;
        }
        if (endDate) {
            where.push('p.created_at <= :endDate');
            params.endDate = endDate;
        }
        if (search) {
            where.push(
                '(p.payment_reference LIKE :search OR p.transaction_id LIKE :search OR u.email LIKE :search)',
            );
            params.search = `%${search}%`;
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const rows = await query(
            `SELECT p.*, b.booking_reference, o.order_reference, i.invoice_number,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM payments p
             JOIN users u ON u.id = p.user_id
             LEFT JOIN bookings b ON b.id = p.booking_id
             LEFT JOIN orders o ON o.id = p.order_id
             LEFT JOIN invoices i
                    ON (i.booking_id = p.booking_id OR i.order_id = p.order_id)
             ${whereSql}
             ORDER BY ${sort.column} ${sort.direction}
             LIMIT :limit OFFSET :offset`,
            { ...params, limit: pagination.limit, offset: pagination.offset },
        );

        const totalRow = await queryOne(
            `SELECT COUNT(*) AS total FROM payments p JOIN users u ON u.id = p.user_id ${whereSql}`,
            params,
        );

        return {
            payments: rows.map(mapPayment),
            total: Number(totalRow?.total || 0),
            page: pagination.page,
            limit: pagination.limit,
            totalPages: Math.max(1, Math.ceil(Number(totalRow?.total || 0) / pagination.limit)),
        };
    },

    /** One payment, with the display joins the receipt needs. */
    async findById(id) {
        const row = await queryOne(
            `SELECT p.*, b.booking_reference, o.order_reference, i.invoice_number,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM payments p
             JOIN users u ON u.id = p.user_id
             LEFT JOIN bookings b ON b.id = p.booking_id
             LEFT JOIN orders o ON o.id = p.order_id
             LEFT JOIN invoices i
                    ON (i.booking_id = p.booking_id OR i.order_id = p.order_id)
             WHERE p.id = :id`,
            { id },
        );
        return mapPayment(row);
    },

    async findByReference(reference) {
        const row = await queryOne('SELECT * FROM payments WHERE payment_reference = :reference', {
            reference,
        });
        return mapPayment(row);
    },

    /** Invoice for a booking, if one has been issued. */
    async findInvoiceByBooking(bookingId) {
        const row = await queryOne(
            `SELECT i.*, b.booking_reference, r.room_number, b.check_in, b.check_out,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM invoices i
             JOIN bookings b ON b.id = i.booking_id
             JOIN rooms r ON r.id = b.room_id
             JOIN users u ON u.id = i.user_id
             WHERE i.booking_id = :bookingId`,
            { bookingId },
        );
        return mapInvoice(row);
    },

    /** Invoice for an order, if one has been issued. */
    async findInvoiceByOrder(orderId) {
        const row = await queryOne(
            `SELECT i.*, o.order_reference,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM invoices i
             JOIN orders o ON o.id = i.order_id
             JOIN users u ON u.id = i.user_id
             WHERE i.order_id = :orderId`,
            { orderId },
        );
        return mapInvoice(row);
    },

    async findInvoiceById(id) {
        const row = await queryOne(
            `SELECT i.*, b.booking_reference, o.order_reference, r.room_number,
                    b.check_in, b.check_out,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM invoices i
             JOIN users u ON u.id = i.user_id
             LEFT JOIN bookings b ON b.id = i.booking_id
             LEFT JOIN rooms r ON r.id = b.room_id
             LEFT JOIN orders o ON o.id = i.order_id
             WHERE i.id = :id`,
            { id },
        );
        return mapInvoice(row);
    },

    /** Every invoice belonging to one user, newest first. */
    async listInvoicesForUser(userId, limit = 50) {
        const rows = await query(
            `SELECT i.*, b.booking_reference, o.order_reference, r.room_number,
                    b.check_in, b.check_out,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             FROM invoices i
             JOIN users u ON u.id = i.user_id
             LEFT JOIN bookings b ON b.id = i.booking_id
             LEFT JOIN rooms r ON r.id = b.room_id
             LEFT JOIN orders o ON o.id = i.order_id
             WHERE i.user_id = :userId
             ORDER BY i.issued_at DESC
             LIMIT :limit`,
            { userId, limit },
        );
        return rows.map(mapInvoice);
    },

    /**
     * Every invoice in the system, for the staff invoice screen.
     *
     * Distinct from `listInvoicesForUser`, which is deliberately scoped to one
     * guest. Staff need the whole ledger, and it is paginated because the
     * invoice table grows without bound.
     */
    async findAllInvoices({ page = 1, limit = 25, status, search, startDate, endDate }) {
        const pagination = resolvePagination({ page, limit });

        const conditions = [];
        const params = {};

        if (status) {
            conditions.push('i.status = :status');
            params.status = status;
        }
        if (search) {
            // The booking and order references are joined columns, so they are
            // searched as well: a manager reconciling a booking will type that
            // reference rather than the invoice number.
            conditions.push(
                `(i.invoice_number LIKE :search
                  OR u.email LIKE :search
                  OR b.booking_reference LIKE :search
                  OR o.order_reference LIKE :search)`,
            );
            params.search = `%${search}%`;
        }
        if (startDate) {
            conditions.push('i.issued_at >= :startDate');
            params.startDate = startDate;
        }
        if (endDate) {
            conditions.push('i.issued_at <= DATE_ADD(:endDate, INTERVAL 1 DAY)');
            params.endDate = endDate;
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Shared FROM clause: the count query needs the same joins as the page
        // query, because the search condition can reference booking and order
        // references. Counting against a narrower FROM would return a total
        // that does not match the rows on screen.
        const from = `FROM invoices i
             JOIN users u ON u.id = i.user_id
             LEFT JOIN bookings b ON b.id = i.booking_id
             LEFT JOIN rooms r ON r.id = b.room_id
             LEFT JOIN orders o ON o.id = i.order_id`;

        const rows = await query(
            `SELECT i.*, b.booking_reference, o.order_reference, r.room_number,
                    b.check_in, b.check_out,
                    CONCAT(u.first_name, ' ', u.last_name) AS guest_name, u.email AS guest_email
             ${from}
             ${where}
             ORDER BY i.issued_at DESC, i.id DESC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, params, { limit: pagination.limit, offset: pagination.offset }),
        );

        const countRow = await queryOne(`SELECT COUNT(*) AS total ${from} ${where}`, params);

        const total = countRow ? Number(countRow.total) : 0;

        return {
            rows: rows.map(mapInvoice),
            total,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        };
    },

    /**
     * Money still owed by one user across bookings and orders.
     * Only completed payments count, so a declined card never reduces a
     * balance.
     */
    async getOutstandingBalance(userId) {
        const row = await queryOne(
            `SELECT COALESCE(SUM(balance_due), 0) AS outstanding
             FROM (
                 SELECT b.total_amount - COALESCE(
                            (SELECT SUM(p.amount) FROM payments p
                             WHERE p.booking_id = b.id AND p.status = 'completed'),
                            0
                        ) AS balance_due
                 FROM bookings b
                 WHERE b.user_id = :userId AND b.status IN ('pending', 'confirmed', 'checked_in')
                 UNION ALL
                 SELECT o.total_amount - COALESCE(
                            (SELECT SUM(p.amount) FROM payments p
                             WHERE p.order_id = o.id AND p.status = 'completed'),
                            0
                        ) AS balance_due
                 FROM orders o
                 WHERE o.user_id = :userId AND o.status NOT IN ('cancelled')
             ) balances`,
            { userId },
        );
        return Number(row?.outstanding || 0);
    },

    // ---- Writes ------------------------------------------------------------

    /**
     * Persists a payment.
     *
     * The raw provider response is stored as JSON for reconciliation. Card
     * numbers are never part of it because the provider only returns a masked
     * value, which is the reason the masking happens down in the provider
     * rather than here.
     */
    async create({
        paymentReference,
        transactionId,
        userId,
        bookingId = null,
        orderId = null,
        amount,
        currency,
        paymentMethod,
        status,
        failureReason = null,
        providerResponse = null,
    }) {
        const result = await execute(
            `INSERT INTO payments
                 (payment_reference, transaction_id, user_id, booking_id, order_id,
                  amount, currency, payment_method, status, failure_reason,
                  provider_response, paid_at)
             VALUES
                 (:paymentReference, :transactionId, :userId, :bookingId, :orderId,
                  :amount, :currency, :paymentMethod, :status, :failureReason,
                  :providerResponse, :paidAt)`,
            {
                paymentReference,
                transactionId,
                userId,
                bookingId,
                orderId,
                amount,
                currency,
                paymentMethod,
                status,
                failureReason,
                providerResponse: providerResponse ? JSON.stringify(providerResponse) : null,
                paidAt: status === 'completed' ? new Date() : null,
            },
        );
        return result.insertId;
    },

    async updateStatus(id, status, { failureReason = null, transactionId = null } = {}) {
        await execute(
            `UPDATE payments
             SET status = :status,
                 failure_reason = COALESCE(:failureReason, failure_reason),
                 transaction_id = COALESCE(:transactionId, transaction_id),
                 paid_at = CASE WHEN :status = 'completed' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
                 refunded_at = CASE WHEN :status = 'refunded' THEN NOW() ELSE refunded_at END
             WHERE id = :id`,
            { id, status, failureReason, transactionId },
        );
        return this.findById(id);
    },

    /**
     * Issues the invoice for a paid booking or order.
     *
     * Uses INSERT IGNORE semantics through the unique keys: re-paying the same
     * booking must update the existing invoice rather than fail on the unique
     * constraint. The balance is recomputed from the payments table rather
     * than incremented, so a replayed request cannot inflate it.
     */
    async upsertInvoice({
        userId,
        bookingId = null,
        orderId = null,
        subtotal,
        taxAmount,
        serviceCharge,
        totalAmount,
        paymentMethod,
        paymentReference,
    }) {
        const paidRow = await queryOne(
            `SELECT COALESCE(SUM(amount), 0) AS paid
             FROM payments
             WHERE status = 'completed' AND (booking_id = :bookingId OR order_id = :orderId)`,
            { bookingId, orderId },
        );

        const amountPaid = Math.min(Number(paidRow?.paid || 0), Number(totalAmount));
        const balanceDue = Number((Number(totalAmount) - amountPaid).toFixed(2));

        const status =
            balanceDue <= 0.005 ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'unpaid';

        await execute(
            `INSERT INTO invoices
                 (invoice_number, booking_id, order_id, user_id, subtotal, tax_amount,
                  service_charge, total_amount, amount_paid, balance_due, status,
                  payment_method, payment_reference)
             VALUES
                 (:invoiceNumber, :bookingId, :orderId, :userId, :subtotal, :taxAmount,
                  :serviceCharge, :totalAmount, :amountPaid, :balanceDue, :status,
                  :paymentMethod, :paymentReference)
             ON DUPLICATE KEY UPDATE
                 amount_paid = VALUES(amount_paid),
                 balance_due = VALUES(balance_due),
                 status = VALUES(status),
                 payment_method = VALUES(payment_method),
                 payment_reference = VALUES(payment_reference)`,
            {
                invoiceNumber: generateInvoiceNumber(),
                bookingId,
                orderId,
                userId,
                subtotal,
                taxAmount,
                serviceCharge,
                totalAmount,
                amountPaid,
                balanceDue,
                status,
                paymentMethod,
                paymentReference,
            },
        );

        return bookingId ? this.findInvoiceByBooking(bookingId) : this.findInvoiceByOrder(orderId);
    },

    /**
     * Records a refund against a completed payment.
     *
     * The check that the payment is completed and not already refunded lives
     * in the service, not here, so the rule stays in one readable place.
     */
    async markRefunded(paymentId) {
        await execute(
            `UPDATE payments
             SET status = 'refunded', refunded_at = NOW()
             WHERE id = :paymentId`,
            { paymentId },
        );
        return this.findById(paymentId);
    },
};

export default paymentRepository;
