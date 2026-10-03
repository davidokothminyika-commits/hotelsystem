/**
 * src/routes/invoices.routes.js
 *
 * WHAT THIS MODULE DOES
 * Declares the invoice and receipt HTTP surface.
 *
 * WHY IT EXISTS
 * Invoices are issued by the payment service, but they are addressed as their
 * own resource: `/api/invoices/...`. They were originally declared as trailing
 * routes on the payments router, where they could never be reached, because
 * that router is mounted at `/api/payments` and so resolved them to
 * `/api/payments/invoices/...`. Every invoice and receipt URL 404'd until the
 * two were separated. Keeping them here makes the mount and the URL agree.
 *
 * MIDDLEWARE ORDER MATTERS HERE
 * `requireAuth` is applied once at the top so that a route added later cannot
 * accidentally be left public. Invoices are financial records and must never
 * be readable anonymously.
 *
 * COMMUNICATION
 * Browser -> /api/invoices/* -> payment.controller.js -> payment.service.js
 * Database tables used: none directly (the service owns all persistence).
 */
import { Router } from 'express';
import paymentController from '../controllers/payment.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { receiptRules, invoiceIdRules, listInvoicesRules } from '../validators/payment.validators.js';

const router = Router();

router.use(requireAuth);

/**
 * The receipt is addressed by what was paid for rather than by invoice id, so
 * it can be requested before an invoice exists.
 */
router.get('/receipt', validate(receiptRules, 'query'), paymentController.receipt);

/**
 * The whole ledger. Declared before '/:id' and restricted to staff, because it
 * is a reporting view across every guest rather than one guest's own invoices,
 * which is what GET / below returns.
 */
router.get('/all', requireRole('manager', 'admin', 'receptionist'), validate(listInvoicesRules, 'query'), paymentController.listAllInvoices);

router.get('/:id', validate(invoiceIdRules), paymentController.getInvoice);
router.get('/', paymentController.listInvoices);

export default router;
