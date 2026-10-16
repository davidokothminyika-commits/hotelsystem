/**
 * src/routes/bookingGroup.routes.js
 *
 * WHAT THIS MODULE DOES
 * Endpoints for group (allotment) reservations: list, create, inspect,
 * confirm, cancel and add rooms to a block.
 *
 * PERMISSION MODEL
 *   Reads   : booking:read   (any role that may see reservations)
 *   Creates : booking:create (front desk takes the booking)
 *   Confirms: booking:update (confirmation is a front desk decision)
 *   Cancels : booking:cancel (releasing six rooms is its own permission)
 * Guests hold none of these, and `requireStaff` is not relied on alone
 * because the permission is the finer grained statement of intent.
 *
 * COMMUNICATION
 * Frontend (public/js/pages/admin/groups.js) -> THIS FILE
 *      -> bookingGroup.controller.js -> bookingGroup.service.js
 * Database tables used: booking_groups, bookings, rooms.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireStaff, requirePermission } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import {
    createGroupRules,
    addRoomsRules,
    listGroupsRules,
    cancelGroupRules,
    idParamRules,
} from '../validators/bookingGroup.validators.js';
import bookingGroupController from '../controllers/bookingGroup.controller.js';

const router = Router();

// Declared before the first route: every guard below reads req.user, which
// only requireAuth populates.
router.use(requireAuth);

// A group is staff machinery: guests hold booking:create and booking:read for
// their own reservations, which is exactly why the permission alone cannot
// gate this router - a guest would pass it and be able to hold six rooms.
// Being staff is the pre-condition, the permission is the fine control.
router.use(requireStaff);

router.get(
    '/',
    requirePermission('booking:read'),
    validate(listGroupsRules, 'query'),
    bookingGroupController.list,
);

router.post(
    '/',
    requirePermission('booking:create'),
    writeLimiter,
    validate(createGroupRules),
    bookingGroupController.create,
);

router.get(
    '/:id',
    requirePermission('booking:read'),
    validate(idParamRules),
    bookingGroupController.detail,
);

router.post(
    '/:id/confirm',
    requirePermission('booking:update'),
    validate(idParamRules),
    bookingGroupController.confirm,
);

router.post(
    '/:id/cancel',
    requirePermission('booking:cancel'),
    writeLimiter,
    validate([...idParamRules, ...cancelGroupRules]),
    bookingGroupController.cancel,
);

router.post(
    '/:id/rooms',
    requirePermission('booking:create'),
    writeLimiter,
    validate([...idParamRules, ...addRoomsRules]),
    bookingGroupController.addRooms,
);

export default router;
