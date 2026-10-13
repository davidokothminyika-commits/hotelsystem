/**
 * src/repositories/report.repository.js
 *
 * WHAT THIS MODULE DOES
 * The read-only aggregates behind the finance report: tax collected on
 * invoices, money actually received through payments, and the per-day rows
 * the daily revenue audit is built from.
 *
 * WHY IT EXISTS
 * Totalling a paginated list in JavaScript produces a confidently wrong
 * number, so every figure here is summed by the database over the whole
 * range. Keeping the SQL in one repository also keeps the two accounting
 * bases (accrual on invoices, cash on payments) visible side by side, which
 * is where they are easiest to keep honest.
 *
 * RANGE SEMANTICS
 * Every method takes an *inclusive* calendar range { from, to } as
 * 'YYYY-MM-DD' strings. The stored columns are DATETIMEs, so the upper bound
 * is expressed as a half-open interval: `issued_at < DATE_ADD(:to, INTERVAL 1
 * DAY)` includes the whole of the end day without any string juggling that
 * could drop records timestamped at 23:59:59.
 *
 * COMMUNICATION
 * Called by: services/reporting.service.js
 * Database tables used: invoices, payments.
 */
import { query, queryOne } from '../config/db.js';

/**
 * Half-open SQL predicate for the inclusive { from, to } range on a DATETIME
 * column: `col >= from AND col < to + 1 day`. The column is named twice on
 * purpose - a bare `AND < DATE_ADD(...)` has no left operand and will not
 * parse.
 */
const inRange = (column) => `${column} >= :from AND ${column} < DATE_ADD(:to, INTERVAL 1 DAY)`;

const reportRepository = {
    /**
     * Accrual totals for invoices issued in the range.
     *
     * Void invoices are excluded: a voided invoice is not revenue and not a
     * tax liability. `balance_due` and `open_invoices` are measured as they
     * stand now rather than as of the range end, because the ledger has no
     * historical balance snapshot to ask.
     */
    async invoiceTotals({ from, to }) {
        return queryOne(
            `SELECT COUNT(*) AS invoices_issued,
                    COALESCE(SUM(subtotal), 0) AS subtotal,
                    COALESCE(SUM(tax_amount), 0) AS tax,
                    COALESCE(SUM(service_charge), 0) AS service_charge,
                    COALESCE(SUM(total_amount), 0) AS total_invoiced,
                    COALESCE(SUM(balance_due), 0) AS balance_due,
                    COALESCE(SUM(status IN ('unpaid', 'partially_paid')), 0) AS open_invoices
             FROM invoices
             WHERE status <> 'void' AND ${inRange('issued_at')}`,
            { from, to },
        );
    },

    /**
     * The same totals split by what was sold: room nights (booking invoices)
     * versus food and beverage (order invoices). Exactly one of booking_id /
     * order_id is set, so booking_id decides the side.
     */
    async invoiceTotalsBySource({ from, to }) {
        return query(
            `SELECT CASE WHEN booking_id IS NOT NULL THEN 'rooms' ELSE 'food' END AS source,
                    COUNT(*) AS invoices_issued,
                    COALESCE(SUM(subtotal), 0) AS subtotal,
                    COALESCE(SUM(tax_amount), 0) AS tax,
                    COALESCE(SUM(service_charge), 0) AS service_charge,
                    COALESCE(SUM(total_amount), 0) AS total_invoiced
             FROM invoices
             WHERE status <> 'void' AND ${inRange('issued_at')}
             GROUP BY source`,
            { from, to },
        );
    },

    /**
     * Cash received in the range, grouped by payment method.
     *
     * Only `completed` payments count. A payment that is later refunded
     * leaves this set entirely (its status becomes 'refunded'), so it stops
     * counting as collected on the day the refund happens - see
     * `refundedTotals` for the other half of that pair.
     */
    async completedPaymentsByMethod({ from, to }) {
        return query(
            `SELECT payment_method, COUNT(*) AS txn_count, COALESCE(SUM(amount), 0) AS amount
             FROM payments
             WHERE status = 'completed' AND ${inRange('paid_at')}
             GROUP BY payment_method`,
            { from, to },
        );
    },

    /**
     * Money returned in the range.
     *
     * Grouped by `refunded_at`, not `paid_at`, so a refund lands on the day
     * it happened. That is deliberate: an audit wants to see the outflow on
     * the day the hotel gave the money back, even though the original
     * collection sits in an earlier period.
     */
    async refundedTotals({ from, to }) {
        return queryOne(
            `SELECT COUNT(*) AS txn_count, COALESCE(SUM(amount), 0) AS amount
             FROM payments
             WHERE status = 'refunded' AND ${inRange('refunded_at')}`,
            { from, to },
        );
    },

    /** Invoices issued per day: what was billed, and the tax inside it. */
    async dailyInvoices({ from, to }) {
        return query(
            `SELECT DATE(issued_at) AS day,
                    COUNT(*) AS invoices_issued,
                    COALESCE(SUM(total_amount), 0) AS total_invoiced,
                    COALESCE(SUM(tax_amount), 0) AS tax
             FROM invoices
             WHERE status <> 'void' AND ${inRange('issued_at')}
             GROUP BY DATE(issued_at)
             ORDER BY day`,
            { from, to },
        );
    },

    /** Payments received per day, regardless of method. */
    async dailyCompletedPayments({ from, to }) {
        return query(
            `SELECT DATE(paid_at) AS day,
                    COUNT(*) AS txn_count,
                    COALESCE(SUM(amount), 0) AS amount
             FROM payments
             WHERE status = 'completed' AND ${inRange('paid_at')}
             GROUP BY DATE(paid_at)
             ORDER BY day`,
            { from, to },
        );
    },

    /** Refunds issued per day. */
    async dailyRefundedPayments({ from, to }) {
        return query(
            `SELECT DATE(refunded_at) AS day,
                    COUNT(*) AS txn_count,
                    COALESCE(SUM(amount), 0) AS amount
             FROM payments
             WHERE status = 'refunded' AND ${inRange('refunded_at')}
             GROUP BY DATE(refunded_at)
             ORDER BY day`,
            { from, to },
        );
    },
};

export default reportRepository;
