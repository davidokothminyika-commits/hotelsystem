/**
 * src/routes/orders.routes.js
 *
 * WHAT THIS MODULE DOES
 * Food ordering endpoints, split between what a guest may do and what
 * restaurant staff may do.
 *
 * PERMISSION MODEL
 *   Guests  : place, view own, cancel own (before it leaves the kitchen)
 *   Kitchen : view all, advance status, cancel any
 *
 * COMMUNICATION
 * Frontend (public/js/api/orders.js) -> THIS FILE -> orders.controller.js
 * Database tables used: orders, order_items, menu_items
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireStaff, requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { auditAction } from '../middleware/audit.middleware.js';
import {
    idParamRules,
    placeOrderRules,
    listOrdersRules,
    updateOrderStatusRules,
    cancelOrderRules,
} from '../validators/restaurant.validators.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import orderController from '../controllers/order.controller.js';

const router = Router();

// Everything below requires a session. This is declared before the first
// route because requireStaff reads req.user, which only requireAuth sets, and
// applying it once here removes the chance of a route forgetting it.
router.use(requireAuth);

// Literal paths before '/:id', so they are not captured as an id.
router.get('/board', requireStaff, orderController.board);
router.get('/counts', requireStaff, orderController.counts);
router.get('/sales', requireStaff, orderController.sales);

router.get('/summary', orderController.summary);
router.get('/', validate(listOrdersRules), orderController.list);

router.post(
    '/',
    writeLimiter,
    validate(placeOrderRules),
    auditAction(AUDIT_ACTIONS.ORDER_CREATED, () => ({ entity: 'orders' })),
    orderController.create,
);

router.get('/:id', validate(idParamRules), orderController.detail);

// Advancing the kitchen workflow is a staff action. A guest may not mark
// their own order "delivered".
router.patch(
    '/:id/status',
    requireRole('restaurant_staff', 'manager', 'admin'),
    validate([...idParamRules, ...updateOrderStatusRules]),
    auditAction(AUDIT_ACTIONS.ORDER_STATUS_CHANGED, () => ({ entity: 'orders' })),
    orderController.updateStatus,
);

// Cancellation is open to guests for their own orders and to staff for any;
// the service decides which records each may touch and when.
router.post(
    '/:id/cancel',
    validate([...idParamRules, ...cancelOrderRules]),
    auditAction(AUDIT_ACTIONS.ORDER_CANCELLED, () => ({ entity: 'orders' })),
    orderController.cancel,
);

export default router;