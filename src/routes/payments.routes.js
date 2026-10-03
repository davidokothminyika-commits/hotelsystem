/**
 * src/routes/payments.routes.js
 *
 * WHAT THIS MODULE DOES
 * Declares the payment and invoice HTTP surface.
 *
 * WHY IT EXISTS
 * Routing is kept out of the controller so the URL shape, the middleware chain
 * and the authorisation rule for each endpoint can be read in one screen.
 *
 * MIDDLEWARE ORDER MATTERS HERE
 * `router.use(requireAuth)` is declared before the first route so that
 * `requireRole` below it always has `req.user` to inspect. Applying requireAuth
 * once at the top removes the chance of a new route being added without it.
 *
 * COMMUNICATION
 * Browser -> /api/payments/* -> payments.controller.js -> payment.service.js
 * Database tables used: none directly (the service owns persistence).
 */
import { Router } from 'express';
import paymentController from '../controllers/payment.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { paymentLimiter } from '../middleware/rateLimit.middleware.js';
import {
    createPaymentRules,
    listPaymentsRules,
    paymentIdRules,
    refundRules,
} from '../validators/payment.validators.js';

const router = Router();

// The payment form is rendered on pages a guest can see before signing in, so
// the provider configuration is deliberately public. It exposes no secrets:
// only method names and the documented test card numbers.
router.get('/config', paymentController.configuration);

router.use(requireAuth);

/** Only staff can move money out of the system. */
const staffOnly = requireRole('manager', 'admin', 'receptionist');

router.get('/', validate(listPaymentsRules), paymentController.list);
router.get('/balance', paymentController.balance);
router.get('/mine', paymentController.list);

// Literal paths before '/:id' so they are not captured as an identifier.
router.post('/', paymentLimiter, validate(createPaymentRules), paymentController.create);
router.post('/:id/refund', staffOnly, validate(refundRules), paymentController.refund);
router.get('/:id', validate(paymentIdRules), paymentController.getOne);

// Invoice and receipt endpoints live in invoices.routes.js and are mounted at
// /api/invoices, so they are reachable at the URLs the frontend actually calls.

export default router;
