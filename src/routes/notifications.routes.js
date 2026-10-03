/**
 * src/routes/notifications.routes.js
 *
 * WHAT THIS MODULE DOES
 * The signed in user's own notifications.
 *
 * WHY IT EXISTS
 * Every endpoint is scoped to the session user rather than accepting a user id,
 * so there is no way to ask this router for someone else's notifications.
 *
 * MIDDLEWARE ORDER MATTERS HERE
 * `/unread-count` and `/read-all` are declared before `/:id`, otherwise Express
 * matches them as an identifier.
 *
 * COMMUNICATION
 * Browser -> /api/notifications/* -> notifications.controller.js -> notification.service.js
 * Database tables used: notifications
 */
import { Router } from 'express';
import notificationController from '../controllers/notification.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { param } from 'express-validator';

const router = Router();

// Nothing here is public: a notification is personal.
router.use(requireAuth);

const idParamRules = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Invalid identifier')
        .toInt(),
];

router.get('/', notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.patch('/read-all', notificationController.markAllAsRead);
router.patch('/:id/read', validate(idParamRules), notificationController.markAsRead);
router.delete('/:id', validate(idParamRules), notificationController.remove);
router.delete('/', notificationController.clearAll);

export default router;
