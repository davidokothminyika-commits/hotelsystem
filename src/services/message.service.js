/**
 * src/services/message.service.js
 *
 * WHAT THIS MODULE DOES
 * Business rules for guest-staff messaging.
 *
 * WHY IT EXISTS
 * The rules that matter here are about who may see a conversation. Membership
 * is enforced in SQL by the repository, but the service still has to decide
 * things SQL cannot: whether a guest may reopen a closed thread, whether staff
 * may see a conversation they were not invited to, and who gets told when a
 * message arrives.
 *
 * A CLOSED CONVERSATION IS NOT DELETED
 * Closing hides the thread from the inbox. Replying reopens it, because a guest
 * who comes back days later should get an answer rather than a dead end.
 *
 * COMMUNICATION
 * Browser -> /api/messages -> messages.controller.js -> THIS FILE
 *          -> message.repository.js, notification.service.js, audit.service.js
 * Database tables used: conversations, conversation_participants, messages, users
 */
import ApiError from '../utils/errors.js';
import messageRepository from '../repositories/message.repository.js';
import notificationService from './notification.service.js';
import auditService, { AUDIT_ACTIONS } from './audit.service.js';

const CONTEXT_TYPES = ['support', 'reception', 'restaurant', 'booking'];

/** Roles that answer guest messages. */
const STAFF_ROLES = ['receptionist', 'manager', 'admin', 'restaurant_staff', 'housekeeping'];

function isStaff(user) {
    return STAFF_ROLES.includes(user?.role);
}

const messageService = {
    /** The signed in user's conversations, plus their unread total. */
    async listMine({ includeClosed }, requester) {
        return {
            conversations: await messageRepository.findConversationsForUser(requester.id, { includeClosed }),
            unread: await messageRepository.countUnreadForUser(requester.id),
        };
    },

    /** Staff inbox: every conversation, not only the reader's own. */
    async listForStaff({ page, limit, includeClosed, search }) {
        return messageRepository.findAllConversations({ page, limit, includeClosed, search });
    },

    async countOpen() {
        return messageRepository.countOpen();
    },

    /**
     * One thread with its messages.
     *
     * A guest may only open a conversation they take part in. Staff may open
     * any, because the inbox is how they answer, and joining implicitly keeps
     * the thread in their own list afterwards.
     */
    async getConversation(id, requester) {
        const existing = await messageRepository.findConversationForUser(id, requester.id);

        if (!existing) {
            if (!isStaff(requester)) {
                // 404 rather than 403: a guest must not learn that a thread with
                // this id exists when they are not part of it.
                throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
            }

            // Staff only, and only if the conversation actually has messages.
            const messages = await messageRepository.findMessages(id, requester.id);
            if (messages.length === 0) {
                throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
            }

            await messageRepository.addParticipant(id, requester.id);
        }

        // Opening a thread marks it read, which is what reading it implies.
        await messageRepository.markConversationRead(id, requester.id);

        const conversation = await messageRepository.findConversationForUser(id, requester.id);
        const messages = await messageRepository.findMessages(id, requester.id);

        return { conversation, messages };
    },

    /**
     * Opens a thread.
     *
     * A guest opening a thread always involves staff, so it is routed to the
     * front desk queue. Staff must name the guests, otherwise the thread would
     * be created with nobody on the other side.
     */
    async createConversation({ subject, contextType, recipientIds }, requester) {
        const cleanSubject = String(subject || '').trim() || 'General Enquiry';

        if (!CONTEXT_TYPES.includes(contextType)) {
            throw ApiError.badRequest('Choose a valid conversation type', 'INVALID_CONTEXT_TYPE');
        }

        let participants;

        if (isStaff(requester)) {
            participants = [...new Set((recipientIds || []).map(Number).filter(Boolean))];
            if (participants.length === 0) {
                throw ApiError.badRequest('Choose at least one guest', 'RECIPIENT_REQUIRED');
            }
        } else {
            // A guest cannot choose their own listener.
            participants = await messageRepository.listStaffIds();
        }

        const conversationId = await messageRepository.createConversation({
            subject: cleanSubject,
            contextType,
            creatorId: requester.id,
            participantIds: participants,
        });

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.MESSAGE_SENT,
            entity: 'conversation',
            entityId: conversationId,
            metadata: { subject: cleanSubject, context_type: contextType },
        });

        const conversation = await messageRepository.findConversationForUser(conversationId, requester.id);
        return { conversation, messages: [] };
    },

    /**
     * Posts a message and tells the other side about it.
     *
     * Replying to a closed thread reopens it, which is deliberate: a guest who
     * returns with a follow-up question should get an answer, not an error.
     */
    async sendMessage(conversationId, body, requester) {
        let conversation = await messageRepository.findConversationForUser(conversationId, requester.id);

        if (!conversation) {
            if (!isStaff(requester)) {
                throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
            }
            // Staff replying to a guest thread join it implicitly.
            await messageRepository.addParticipant(conversationId, requester.id);
            conversation = await messageRepository.findConversationForUser(conversationId, requester.id);
        } else if (conversation.isClosed) {
            await messageRepository.setClosed(conversationId, false);
        }

        const messageId = await messageRepository.createMessage({
            conversationId,
            senderId: requester.id,
            body,
        });

        // The sender is excluded: being notified about your own message is noise.
        await this.notifyParticipants(conversationId, requester);

        await auditService.record({
            userId: requester.id,
            action: AUDIT_ACTIONS.MESSAGE_SENT,
            entity: 'conversation',
            entityId: conversationId,
        });

        return {
            id: messageId,
            conversationId: Number(conversationId),
            senderId: requester.id,
            body,
            isOwn: true,
            createdAt: new Date().toISOString(),
        };
    },

    /** Notifies every participant except the sender that a message arrived. */
    async notifyParticipants(conversationId, sender) {
        const participants = await messageRepository.listParticipantIds(conversationId);
        const senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Someone';

        for (const userId of participants) {
            if (Number(userId) === Number(sender.id)) continue;

            await notificationService.notifyMessageReceived({
                userId: Number(userId),
                senderName,
                conversationId: Number(conversationId),
            });
        }
    },

    async setClosed(id, isClosed, requester) {
        const conversation = await messageRepository.findConversationForUser(id, requester.id);
        if (!conversation && !isStaff(requester)) {
            throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
        }

        await messageRepository.setClosed(id, isClosed);
        return { id: Number(id), isClosed: Boolean(isClosed) };
    },
};

export default messageService;
