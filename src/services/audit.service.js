/**
 * src/services/audit.service.js
 *
 * WHAT THIS MODULE DOES
 * Writes and queries audit trail entries.
 *
 * WHY IT EXISTS
 * Logging is a cross-cutting concern used by middleware, controllers and
 * services. Giving it a service means the storage format (for example how
 * metadata is serialised) is decided once.
 *
 * COMMUNICATION
 * Called by: middleware/audit.middleware.js and selected services.
 * Database tables used: audit_logs, users.
 */
import auditRepository from '../repositories/audit.repository.js';

/** Canonical action names, so logs are consistent and greppable. */
export const AUDIT_ACTIONS = Object.freeze({
    LOGIN: 'auth.login',
    LOGIN_FAILED: 'auth.login_failed',
    LOGOUT: 'auth.logout',
    REGISTER: 'auth.register',
    PASSWORD_CHANGED: 'auth.password_changed',
    PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
    PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
    EMAIL_VERIFIED: 'auth.email_verified',
    PROFILE_UPDATED: 'user.profile_updated',
    USER_CREATED: 'user.created',
    USER_UPDATED: 'user.updated',
    USER_DELETED: 'user.deleted',
    ROLE_UPDATED: 'role.updated',
    ROOM_CREATED: 'room.created',
    ROOM_UPDATED: 'room.updated',
    ROOM_STATUS_CHANGED: 'room.status_changed',
    BOOKING_CREATED: 'booking.created',
    BOOKING_UPDATED: 'booking.updated',
    BOOKING_CANCELLED: 'booking.cancelled',
    BOOKING_CHECKED_IN: 'booking.checked_in',
    BOOKING_CHECKED_OUT: 'booking.checked_out',
    ORDER_CREATED: 'order.created',
    ORDER_STATUS_CHANGED: 'order.status_changed',
    ORDER_CANCELLED: 'order.cancelled',
    MENU_ITEM_CREATED: 'menu.item_created',
    MENU_ITEM_UPDATED: 'menu.item_updated',
    MENU_ITEM_DELETED: 'menu.item_deleted',
    PAYMENT_COMPLETED: 'payment.completed',
    PAYMENT_FAILED: 'payment.failed',
    PAYMENT_REFUNDED: 'payment.refunded',
    REVIEW_CREATED: 'review.created',
    REVIEW_MODERATED: 'review.moderated',
    MESSAGE_SENT: 'chat.message_sent',
    BRANDING_UPDATED: 'settings.branding_updated',
});

const auditService = {
    /** Records one entry. Callers are responsible for handling errors. */
    async record({ userId, action, entity, entityId, ipAddress, userAgent, metadata }) {
        return auditRepository.insert({ userId, action, entity, entityId, ipAddress, userAgent, metadata });
    },

    /**
     * Resolves a user id from an email for failed-login auditing.
     * Returns null when the address is unknown, which is the common case for
     * a brute force attempt.
     */
    async findUserIdByEmail(email) {
        if (!email) return null;
        const { queryOne } = await import('../config/db.js');
        const row = await queryOne('SELECT id FROM users WHERE email = :email', { email: String(email).toLowerCase() });
        return row ? row.id : null;
    },

    async list({ page, limit, search, action, userId, startDate, endDate }) {
        return auditRepository.findMany({ page, limit, search, action, userId, startDate, endDate });
    },

    async listActions() {
        return auditRepository.listActions();
    },

    async recent(limit = 10) {
        return auditRepository.findRecent(limit);
    },
};

export default auditService;