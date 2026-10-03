/**
 * src/services/payment.service.js
 *
 * WHAT THIS MODULE DOES
 * Orchestrates a payment end to end: works out what is owed, asks the provider
 * to charge it, records the attempt, and on success issues the invoice and
 * updates the balance on the booking or order.
 *
 * WHY IT EXISTS
 * This is the only place that knows the sequence. Controllers stay thin,
 * repositories stay dumb SQL, and the provider stays ignorant of the
 * database. Because every step lives here, adding a real gateway changes one
 * import, not the whole flow.
 *
 * MONEY RULES ENFORCED HERE
 *   1. The amount charged is recomputed from the booking or order, never taken
 *      from the request. A client asking to be charged one cent must not be
 *      able to do it.
 *   2. A charge cannot exceed the outstanding balance.
 *   3. A failed or cancelled charge still records a payment row, because a
 *      decline is a real event that support and reports need to see.
 *   4. The payment row and the balance update happen in one transaction.
 *   5. An invoice is only issued once the money is actually recorded as
 *      completed, never on a pending or failed attempt.
 *   6. Card details are never stored. The provider returns only a masked
 *      value, and only that is persisted.
 *
 * COMMUNICATION
 * Browser -> /api/payments -> payments.controller.js -> THIS FILE
 *          -> payments/index.js (provider registry) -> mock.provider.js
 *          -> payment.repository.js, booking.repository.js, order.repository.js
 *          -> notification.service.js, audit.service.js
 * Database tables used: payments, invoices, bookings, orders, users, rooms
 */
import ApiError from '../utils/errors.js';
import { PRICING, calculateTotals } from '../config/pricing.js';
import { charge, refund, listProviders, getProvider, TEST_CARDS } from './payments/index.js';
import paymentRepository from '../repositories/payment.repository.js';
import bookingRepository from '../repositories/booking.repository.js';
import orderRepository from '../repositories/order.repository.js';
import notificationService from './notification.service.js';
import auditService, { AUDIT_ACTIONS } from './audit.service.js';
import { withTransaction } from '../config/db.js';

/** Payment methods the simulated gateway accepts. */
export const PAYMENT_METHODS = Object.freeze(['card', 'mobile_money', 'cash']);

/** Entities that can be paid for. */
const PAYABLE = Object.freeze({ booking: 'booking', order: 'order' });

/**
 * Statuses the `payments.status` enum accepts.
 *
 * The provider contract is richer than the schema: it distinguishes a
 * cancellation from a decline, because they mean different things to a guest
 * and to support. The table does not, and it should not grow a `cancelled`
 * member just to mirror a provider detail: from the ledger's point of view a
 * cancelled attempt is an attempt that did not succeed, and an enum that
 * silently truncated the value would record it as an empty string and destroy
 * the audit trail. So the distinction is collapsed deliberately here, and the
 * provider's own wording survives in `failure_reason`.
 */
const STORABLE_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'failed', 'refunded']);

/** Maps a provider status onto a status the schema can hold. */
function toStorableStatus(status) {
    return STORABLE_STATUSES.includes(status) ? status : 'failed';
}

/**
 * Loads the thing being paid for and checks the payer is allowed to pay it.
 *
 * A guest paying someone else's bill is rejected with 404 rather than 403 so
 * the endpoint does not confirm that the booking or order exists.
 */
async function resolvePayable({ entity, id, requester }) {
    if (entity === PAYABLE.booking) {
        const booking = await bookingRepository.findById(id);
        if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');

        const isOwner = Number(booking.userId) === Number(requester.id);
        const isStaff = requester.role !== 'guest';
        if (!isOwner && !isStaff) {
            throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
        }

        if (booking.status === 'cancelled') {
            throw ApiError.badRequest('A cancelled booking cannot be paid', 'BOOKING_CANCELLED');
        }

        return { kind: PAYABLE.booking, record: booking };
    }

    if (entity === PAYABLE.order) {
        const order = await orderRepository.findById(id);
        if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');

        const isOwner = Number(order.userId) === Number(requester.id);
        const isStaff = requester.role !== 'guest';
        if (!isOwner && !isStaff) {
            throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
        }

        if (order.status === 'cancelled') {
            throw ApiError.badRequest('A cancelled order cannot be paid', 'ORDER_CANCELLED');
        }

        return { kind: PAYABLE.order, record: order };
    }

    throw ApiError.badRequest('Specify whether you are paying a booking or an order', 'INVALID_ENTITY');
}

/** Splits a stored record back into the invoice line items. */
function invoiceLines(record) {
    const subtotal = Number(record.subtotal ?? record.totalAmount) || 0;
    return calculateTotals(subtotal);
}

const paymentService = {
    /** Providers and test cards the frontend needs to render the payment form. */
    getConfiguration() {
        const active = getProvider();
        return {
            provider: active.name,
            providerName: active.displayName,
            currency: PRICING.currency,
            methods: PAYMENT_METHODS,
            simulated: true,
            testCards: TEST_CARDS,
            providers: listProviders(),
        };
    },

    /** Paginated payment history. Guests see only their own. */
    async listPayments({ requester, page, limit, status, method, search, startDate, endDate }) {
        return paymentRepository.findMany({
            page,
            limit,
            // Staff see every payment; a guest is always scoped to their own id.
            userId: requester.role === 'guest' ? requester.id : undefined,
            status,
            method,
            search,
            startDate,
            endDate,
        });
    },

    /** One payment, enforcing that a guest may only read their own. */
    async getPayment(id, requester) {
        const payment = await paymentRepository.findById(id);
        if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');

        if (requester.role === 'guest' && Number(payment.userId) !== Number(requester.id)) {
            throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
        }

        return payment;
    },

    /**
     * Charges a booking or an order.
     *
     * @param {object} options
     * @param {string} options.entity      'booking' or 'order'
     * @param {number} options.id          The booking or order id.
     * @param {string} options.method      card | mobile_money | cash
     * @param {string} [options.cardNumber]
     * @param {string} [options.cardHolder]
     * @param {string} [options.expiryMonth]
     * @param {string} [options.expiryYear]
     * @param {string} [options.cvv]
     * @param {string} [options.mobileNumber]
     * @param {string} [options.outcome]   Lets the developer force a failure or
     *   a cancellation so the decline paths can be demonstrated.
     * @param {object} requester           The authenticated user.
     */
    async createPayment({ entity, id, method, cardNumber, cardHolder, expiryMonth, expiryYear, cvv, mobileNumber, outcome }, requester) {
        if (!PAYMENT_METHODS.includes(method)) {
            throw ApiError.badRequest('Choose a valid payment method', 'INVALID_PAYMENT_METHOD');
        }

        const { kind, record } = await resolvePayable({ entity, id, requester });

        const totals = invoiceLines(record);
        const outstanding = Number((Number(record.totalAmount) - Number(record.amountPaid)).toFixed(2));

        // Paying nothing, or paying more than is owed, is rejected before the
        // provider is contacted. Refunds handle the overpaid case.
        if (outstanding <= 0.005) {
            throw ApiError.badRequest('This has already been paid in full', 'ALREADY_PAID');
        }

        // Amounts are held to two decimals to keep the recorded payment equal
        // to the reduction in the balance it causes.
        const amount = Number(outstanding.toFixed(2));

        // Card details are validated for presence only. They are passed to the
        // provider and then dropped: nothing downstream needs them, and not
        // retaining them is the safest way to avoid storing a PAN.
        if (method === 'card') {
            if (!cardNumber || !cardHolder || !expiryMonth || !expiryYear || !cvv) {
                throw ApiError.badRequest(
                    'Complete every card field before paying',
                    'INCOMPLETE_CARD_DETAILS',
                );
            }
        }

        // ---- Ask the provider ------------------------------------------------
        const result = await charge({
            amount,
            currency: PRICING.currency,
            method,
            cardNumber,
            mobileNumber,
            outcome,
        });

        // ---- Record the attempt ---------------------------------------------
        // A decline is persisted too. Without it the audit trail would show
        // nothing at all about a failed attempt, which is exactly the event an
        // auditor or support agent most wants to see.
        const paymentId = await paymentRepository.create({
            paymentReference: result.reference,
            transactionId: result.transactionId,
            userId: record.userId,
            bookingId: kind === PAYABLE.booking ? record.id : null,
            orderId: kind === PAYABLE.order ? record.id : null,
            amount,
            currency: PRICING.currency,
            paymentMethod: method,
            status: toStorableStatus(result.status),
            failureReason: result.status === 'completed' ? null : result.message,
            // Only the masked summary is kept. A full card number never gets
            // this far because the provider masks it before returning.
            providerResponse: {
                brand: result.brand,
                lastFour: result.lastFour,
                requiresSettlement: result.requiresSettlement || false,
                failureCode: result.failureCode || null,
            },
        });

        const payment = await paymentRepository.findById(paymentId);

        // ---- Failure paths ---------------------------------------------------
        if (result.status !== 'completed') {
            await notificationService.notifyPaymentFailed(payment);
            await auditService.record({
                userId: requester.id,
                action: AUDIT_ACTIONS.PAYMENT_FAILED,
                entity: kind,
                entityId: record.id,
                metadata: { payment_reference: result.reference, reason: result.message },
            });

            // A decline is a normal outcome, not a server fault. It is returned
            // as a 402 so the client can distinguish it from a validation
            // error and show the gateway message rather than a generic one.
            throw ApiError.paymentRequired(result.message, result.failureCode || 'PAYMENT_FAILED', {
                payment,
            });
        }

        // ---- Success ---------------------------------------------------------
        // The balance update and the invoice both depend on the payment having
        // been recorded, so they run together and roll back together.
        await withTransaction(async (connection) => {
            if (kind === PAYABLE.booking) {
                await bookingRepository.addPaymentAmount(record.id, amount, connection);
            } else {
                await orderRepository.addPaymentAmount(record.id, amount, connection);
            }
        });

        const invoice = await paymentRepository.upsertInvoice({
            userId: record.userId,
            bookingId: kind === PAYABLE.booking ? record.id : null,
            orderId: kind === PAYABLE.order ? record.id : null,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            serviceCharge: totals.serviceCharge,
            totalAmount: totals.totalAmount,
            paymentMethod: method,
            paymentReference: result.reference,
        });

        await notificationService.notifyPaymentCompleted({ ...payment, invoiceId: invoice?.id });
        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.PAYMENT_COMPLETED,
            entity: kind,
            entityId: record.id,
            metadata: {
                payment_reference: result.reference,
                amount,
                method,
                invoice_number: invoice?.invoiceNumber,
            },
        });

        return {
            payment: await paymentRepository.findById(paymentId),
            invoice,
            message: result.message,
        };
    },

    /** Refunds a completed payment. Staff only. */
    async refundPayment(id, requester, reason) {
        const payment = await this.getPayment(id, requester);

        if (payment.status !== 'completed') {
            throw ApiError.badRequest(
                'Only a completed payment can be refunded',
                'NOT_REFUNDABLE',
            );
        }

        const result = await refund({
            paymentReference: payment.paymentReference,
            amount: payment.amount,
        });

        const updated = await paymentRepository.markRefunded(payment.id);

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.PAYMENT_REFUNDED,
            entity: 'payment',
            entityId: payment.id,
            metadata: { payment_reference: payment.paymentReference, reason: reason || null },
        });

        return { payment: updated, message: result.message };
    },

    /** Money still owed by one guest. Feeds the dashboard card. */
    async getOutstandingBalance(userId) {
        return paymentRepository.getOutstandingBalance(userId);
    },

    /** Invoices for one guest. */
    async listInvoices(userId) {
        return paymentRepository.listInvoicesForUser(userId);
    },

    /**
     * Every invoice, for the staff invoice screen.
     *
     * Separate from `listInvoices`, which is scoped to one guest and is what the
     * guest facing page uses.
     */
    async listAllInvoices({ page, limit, status, search, startDate, endDate }) {
        return paymentRepository.findAllInvoices({ page, limit, status, search, startDate, endDate });
    },

    /** One invoice, enforcing ownership. */
    async getInvoice(id, requester) {
        const invoice = await paymentRepository.findInvoiceById(id);
        if (!invoice) throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');

        if (requester.role === 'guest' && Number(invoice.userId) !== Number(requester.id)) {
            throw ApiError.notFound('Invoice not found', 'INVOICE_NOT_FOUND');
        }

        return invoice;
    },

    /** The receipt for a booking or an order, issued on demand if missing. */
    async getReceipt({ entity, id, requester }) {
        const { kind, record } = await resolvePayable({ entity, id, requester });

        const existing =
            kind === PAYABLE.booking
                ? await paymentRepository.findInvoiceByBooking(record.id)
                : await paymentRepository.findInvoiceByOrder(record.id);

        if (existing) return existing;

        // No payment yet, so there is nothing to issue. Returning the record's
        // own totals lets the UI show a proforma bill rather than an error,
        // which is what a guest expects when they open an unpaid booking.
        const totals = invoiceLines(record);
        return {
            invoiceNumber: null,
            isProforma: true,
            bookingId: kind === PAYABLE.booking ? record.id : null,
            orderId: kind === PAYABLE.order ? record.id : null,
            userId: record.userId,
            guestName: record.guestName,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            serviceCharge: totals.serviceCharge,
            totalAmount: totals.totalAmount,
            amountPaid: Number(record.amountPaid),
            balanceDue: Number((Number(record.totalAmount) - Number(record.amountPaid)).toFixed(2)),
            status: Number(record.amountPaid) > 0 ? 'partially_paid' : 'unpaid',
        };
    },
};

export default paymentService;
