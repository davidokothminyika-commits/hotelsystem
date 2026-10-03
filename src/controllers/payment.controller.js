/**
 * src/controllers/payment.controller.js
 *
 * WHAT THIS MODULE DOES
 * Translates HTTP requests into payment service calls and service results into
 * the standard API envelope.
 *
 * WHY IT EXISTS
 * Controllers hold no business logic. Keeping them this thin means the rules
 * are testable without HTTP, and a change to the response shape does not touch
 * the payment logic.
 *
 * EVERY HANDLER IS WRAPPED IN asyncHandler
 * This is not decoration. Express 4 does not catch a rejected promise from an
 * async handler, so a bare `async (req, res) => {}` that throws leaks the
 * rejection out of the router entirely: no response is ever sent, the request
 * hangs until it times out, and the error surfaces as an uncaught exception
 * that can take the process down. Payment is the most throw-heavy module in
 * the system, because a declined card is a normal `throw` of a 402, so this
 * file is exactly where that mistake would hurt most.
 *
 * COMMUNICATION
 * Browser -> /api/payments -> THIS FILE -> services/payment.service.js
 * Database tables used: none (the service owns all persistence).
 */
import paymentService from '../services/payment.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { sendSuccess, sendPaginated } from '../utils/response.js';

const paymentController = {
    /**
     * GET /api/payments/config
     *
     * Public, because the payment form needs the accepted methods and the test
     * cards before the guest has signed in.
     */
    configuration: asyncHandler(async (_req, res) => {
        sendSuccess(res, 'Payment configuration loaded', paymentService.getConfiguration());
    }),

    /** GET /api/payments */
    list: asyncHandler(async (req, res) => {
        const result = await paymentService.listPayments({
            requester: req.user,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            method: req.query.method,
            search: req.query.search,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });

        // sendPaginated, not sendSuccess: the frontend pagination component
        // expects its metadata under `meta`, and hand-rolling it here is how
        // the shape drifted out of step with every other list endpoint.
        return sendPaginated(
            res,
            result.payments,
            { page: result.page, limit: result.limit, total: result.total },
            'Payments retrieved',
        );
    }),

    /** GET /api/payments/:id */
    getOne: asyncHandler(async (req, res) => {
        const payment = await paymentService.getPayment(req.params.id, req.user);
        sendSuccess(res, 'Payment retrieved', { payment });
    }),

    /**
     * POST /api/payments
     *
     * Returns 201 on success. A declined card is handled by the service, which
     * throws a 402 carrying the gateway message and the recorded payment, so
     * the frontend can show the reason and keep the form populated. That throw
     * reaches the error middleware only because of the asyncHandler wrapper.
     */
    create: asyncHandler(async (req, res) => {
        const result = await paymentService.createPayment(
            {
                entity: req.body.entity,
                id: req.body.id,
                method: req.body.method,
                cardNumber: req.body.cardNumber,
                cardHolder: req.body.cardHolder,
                expiryMonth: req.body.expiryMonth,
                expiryYear: req.body.expiryYear,
                cvv: req.body.cvv,
                mobileNumber: req.body.mobileNumber,
                outcome: req.body.outcome,
            },
            req.user,
        );

        sendSuccess(res, result.message, result, 201);
    }),

    /** POST /api/payments/:id/refund */
    refund: asyncHandler(async (req, res) => {
        const result = await paymentService.refundPayment(
            req.params.id,
            req.user,
            req.body.reason,
        );
        sendSuccess(res, result.message, { payment: result.payment });
    }),

    /** GET /api/payments/balance */
    balance: asyncHandler(async (req, res) => {
        const outstanding = await paymentService.getOutstandingBalance(req.user.id);
        sendSuccess(res, 'Balance retrieved', { outstanding, currency: 'USD' });
    }),

    /** GET /api/invoices */
    listInvoices: asyncHandler(async (req, res) => {
        const invoices = await paymentService.listInvoices(req.user.id);
        sendSuccess(res, 'Invoices retrieved', invoices);
    }),

    /** GET /api/invoices/all — the whole ledger, for staff. */
    listAllInvoices: asyncHandler(async (req, res) => {
        const result = await paymentService.listAllInvoices({
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            search: req.query.search,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Invoices retrieved',
        );
    }),

    /** GET /api/invoices/:id */
    getInvoice: asyncHandler(async (req, res) => {
        const invoice = await paymentService.getInvoice(req.params.id, req.user);
        sendSuccess(res, 'Invoice retrieved', { invoice });
    }),

    /**
     * GET /api/invoices/receipt?entity=booking&id=1
     *
     * The receipt is addressed by what was paid for rather than by invoice id,
     * so it works before an invoice exists and returns a proforma instead.
     */
    receipt: asyncHandler(async (req, res) => {
        const invoice = await paymentService.getReceipt({
            entity: req.query.entity,
            id: req.query.id,
            requester: req.user,
        });
        sendSuccess(res, 'Receipt retrieved', { invoice });
    }),
};

export default paymentController;
