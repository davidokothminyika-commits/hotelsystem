/**
 * src/routes/messages.routes.js
 *
 * WHAT THIS MODULE DOES
 * Guest-to-staff messaging: a guest sees their own threads, staff see an inbox
 * of every open thread.
 *
 * WHY IT EXISTS
 * The two audiences are genuinely different views over the same rows, so they
 * are separated here rather than filtered in the frontend. The membership rule
 * is enforced by the service and by the repository's SQL, not by which links
 * the page happens to render.
 *
 * MIDDLEWARE ORDER MATTERS HERE
 * Literal paths (`/inbox`, `/unread-count`) are declared before `/:id`.
 *
 * COMMUNICATION
 * Browser -> /api/messages/* -> messages.controller.js -> message.service.js
 * Database tables used: conversations, conversation_participants, messages
 */
import { Router } from 'express';
import messageController from '../controllers/message.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import {
    idParamRules,
    listConversationsRules,
    staffInboxRules,
    createConversationRules,
    sendMessageRules,
    closeConversationRules,
} from '../validators/message.validators.js';

const router = Router();

// Nobody browses messages anonymously.
router.use(requireAuth);

/** Staff answer guest questions through the inbox. */
const staff = requireRole('receptionist', 'manager', 'admin', 'restaurant_staff', 'housekeeping');

router.get('/', validate(listConversationsRules), messageController.listMine);
router.get('/unread-count', messageController.unreadCount);
router.get('/inbox', staff, validate(staffInboxRules), messageController.listForStaff);

router.post('/', writeLimiter, validate(createConversationRules), messageController.create);
router.post(
    '/:id/messages',
    writeLimiter,
    validate(sendMessageRules),
    messageController.send,
);
router.patch('/:id/close', validate(closeConversationRules), messageController.setClosed);
router.get('/:id', validate(idParamRules), messageController.getOne);

export default router;
