/**
 * src/routes/menu.routes.js
 *
 * WHAT THIS MODULE DOES
 * Menu browsing for everyone, menu management for restaurant staff.
 *
 * ROUTE ORDER MATTERS
 * `/categories` and `/stats` are declared before `/:id` so the literal paths
 * are not captured as an identifier.
 *
 * COMMUNICATION
 * Frontend (public/js/api/menu.js) -> THIS FILE -> menu.controller.js
 * Database tables used: menu_categories, menu_items
 */
import { Router } from 'express';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware.js';
import { requireStaff, requireRole } from '../middleware/authorization.middleware.js';
// requireStaff and requireRole both live in the authorization middleware;
// only authentication comes from auth.middleware.js.
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { uploadSingle } from '../middleware/upload.middleware.js';
import { auditAction } from '../middleware/audit.middleware.js';
import {
    idParamRules,
    browseMenuRules,
    createMenuItemRules,
    updateMenuItemRules,
    setAvailabilityRules,
} from '../validators/restaurant.validators.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import menuController from '../controllers/menu.controller.js';

const router = Router();

// ---------------------------------------------------------------------------
// Public: guests can browse the menu without signing in
// ---------------------------------------------------------------------------

// optionalAuth rather than requireAuth: the menu is public, but knowing the
// role lets the service hide unavailable items from guests while showing
// them to staff browsing the same page.
router.get('/categories', optionalAuth, menuController.categories);

// Literal paths before '/:id'.
router.get('/stats', requireStaff, menuController.stats);
router.get('/popular', requireStaff, menuController.popular);

router.get('/', optionalAuth, validate(browseMenuRules), menuController.browse);

router.get('/:id', optionalAuth, validate(idParamRules), menuController.detail);

// ---------------------------------------------------------------------------
// Management: restaurant staff and above
// ---------------------------------------------------------------------------

/**
 * requireRole reads req.user, which is only populated by requireAuth. Every
 * management route below therefore needs authentication applied first, not
 * just a role check. One router.use sets that up once so an individual route
 * cannot forget it.
 */
router.use(requireAuth);

// Marking an item sold out is a routine kitchen action, so it is open to
// restaurant staff rather than requiring management.
router.patch(
    '/:id/availability',
    requireRole('restaurant_staff', 'manager', 'admin'),
    validate([...idParamRules, ...setAvailabilityRules]),
    menuController.setAvailability,
);

router.post(
    '/',
    requireRole('restaurant_staff', 'manager', 'admin'),
    writeLimiter,
    validate(createMenuItemRules),
    uploadSingle('menu'),
    auditAction(AUDIT_ACTIONS.MENU_ITEM_CREATED, () => ({ entity: 'menu_items' })),
    menuController.create,
);

router.patch(
    '/:id',
    requireRole('restaurant_staff', 'manager', 'admin'),
    validate([...idParamRules, ...updateMenuItemRules]),
    uploadSingle('menu'),
    menuController.update,
);

router.delete('/:id', requireRole('manager', 'admin'), validate(idParamRules), menuController.remove);

export default router;