/**
 * src/services/notification.service.js
 *
 * WHAT THIS MODULE DOES
 * Creates the in-app notifications a guest or staff member sees in the header
 * bell. Composes the message for each domain event (booking confirmed, order
 * ready, payment received and so on).
 *
 * WHY IT EXISTS
 * Business services should say what happened, not how a notification reads.
 * Keeping message wording here means a booking service call reads
 * `notifyBookingConfirmed(booking)` and the wording can be improved in one
 * file without touching business logic.
 *
 * NOTIFICATIONS NEVER THROW
 * A failed notification must never roll back the business action that caused
 * it. Every method catches its own errors and logs them.
 *
 * COMMUNICATION
 * Called by: booking, order, payment and review services.
 * Database tables used: notifications
 * Frontend access: /api/notifications
 */
import env from '../config/env.js';
import notificationRepository from '../repositories/notification.repository.js';
import { formatMoney } from '../config/pricing.js';

/**
 * Formats money for notification text.
 * Delegates to the shared pricing helper so every surface formats amounts
 * identically, and so this service does not import booking.service.js
 * (which would be circular: booking imports notifications).
 */
function money(amount) {
    return formatMoney(amount);
}

const notificationService = {
    /** Generic creator used by the domain helpers below. */
    async create({ userId, type, title, body, data }) {
        try {
            return await notificationRepository.create({ userId, type, title, body, data });
        } catch (error) {
            // Never propagate: the business action already succeeded.
            console.error(`[notification] Failed to create "${type}" for user ${userId}:`, error.message);
            return null;
        }
    },

    // -------------------------------------------------------------------------
    // Booking events
    // -------------------------------------------------------------------------

    async notifyBookingCreated(booking) {
        return this.create({
            userId: booking.userId,
            type: 'booking_confirmation',
            title: 'Booking request received',
            body: `We have received your booking request for room ${booking.roomNumber}. It is awaiting confirmation.`,
            data: { url: '/pages/guest/booking-details.html', booking_id: booking.id, booking_reference: booking.bookingReference },
        });
    },

    async notifyBookingConfirmed(booking) {
        return this.create({
            userId: booking.userId,
            type: 'booking_confirmation',
            title: `Booking ${booking.bookingReference} confirmed`,
            body: `Your stay in room ${booking.roomNumber} from ${booking.checkIn} to ${booking.checkOut} is confirmed. Total ${money(booking.totalAmount)}.`,
            data: { url: '/pages/guest/booking-details.html', booking_id: booking.id, booking_reference: booking.bookingReference },
        });
    },

    async notifyBookingCancelled(booking, reason) {
        return this.create({
            userId: booking.userId,
            type: 'booking_cancellation',
            title: `Booking ${booking.bookingReference} cancelled`,
            body: reason
                ? `Your booking has been cancelled. Reason: ${reason}`
                : 'Your booking has been cancelled and the room has been released.',
            data: { url: '/pages/guest/bookings.html', booking_id: booking.id },
        });
    },

    async notifyCheckedIn(booking) {
        return this.create({
            userId: booking.userId,
            type: 'booking_confirmation',
            title: 'Welcome to ' + env.appName,
            body: `You have checked in to room ${booking.roomNumber}. Enjoy your stay.`,
            data: { url: '/pages/guest/booking-details.html', booking_id: booking.id },
        });
    },

    async notifyCheckedOut(booking) {
        const balance = booking.totalAmount - booking.amountPaid;
        return this.create({
            userId: booking.userId,
            type: 'booking_confirmation',
            title: 'Thank you for staying with us',
            body:
                balance > 0
                    ? `You have checked out of room ${booking.roomNumber}. A balance of ${money(balance)} is outstanding.`
                    : `You have checked out of room ${booking.roomNumber}. We hope you enjoyed your stay.`,
            data: { url: '/pages/guest/booking-details.html', booking_id: booking.id },
        });
    },

    // -------------------------------------------------------------------------
    // Restaurant events
    // -------------------------------------------------------------------------

    async notifyOrderPlaced(order) {
        return this.create({
            userId: order.userId,
            type: 'food_order',
            title: `Order ${order.orderReference} received`,
            body: `We have received your order for ${money(order.totalAmount)}. The kitchen will begin shortly.`,
            data: { url: '/pages/guest/order-details.html', order_id: order.id, order_reference: order.orderReference },
        });
    },

    async notifyOrderStatusChanged(order) {
        const messages = {
            confirmed: 'Your order has been confirmed by the kitchen.',
            preparing: 'Your order is being prepared.',
            ready: 'Your order is ready.',
            out_for_delivery: 'Your order is on its way to your room.',
            delivered: 'Your order has been delivered. Enjoy.',
            cancelled: 'Your order has been cancelled.',
        };

        return this.create({
            userId: order.userId,
            type: 'food_order',
            title: `Order ${order.orderReference} update`,
            body: messages[order.status] || `Your order is now ${order.status}.`,
            data: { url: '/pages/guest/order-details.html', order_id: order.id, order_reference: order.orderReference },
        });
    },

    // -------------------------------------------------------------------------
    // Payment events
    // -------------------------------------------------------------------------

    async notifyPaymentCompleted(payment) {
        return this.create({
            userId: payment.userId,
            type: 'payment_success',
            title: 'Payment received',
            body: `We received your payment of ${money(payment.amount)} (reference ${payment.paymentReference}).`,
            data: { url: '/pages/guest/invoices.html', payment_id: payment.id, invoice_id: payment.invoiceId },
        });
    },

    async notifyPaymentFailed(payment) {
        return this.create({
            userId: payment.userId,
            type: 'payment_failure',
            title: 'Payment could not be completed',
            body: payment.failureReason
                ? `Your payment was declined: ${payment.failureReason}`
                : 'Your payment could not be completed. Please try again with a different method.',
            data: { url: '/pages/guest/payments.html', payment_id: payment.id },
        });
    },

    // -------------------------------------------------------------------------
    // Account events
    // -------------------------------------------------------------------------

    async notifyMessageReceived({ userId, senderName, conversationId }) {
        return this.create({
            userId,
            type: 'new_message',
            title: `New message from ${senderName}`,
            body: `You have a new message. Open the conversation to reply.`,
            data: { url: '/pages/guest/messages.html', conversation_id: conversationId },
        });
    },

    async notifyReviewResponse(review) {
        return this.create({
            userId: review.user_id,
            type: 'review_response',
            title: 'Response to your review',
            body: `${env.appName} has responded to your review.`,
            data: { url: '/pages/guest/reviews.html', review_id: review.id },
        });
    },

    async notifyEmailVerified(userId) {
        return this.create({
            userId,
            type: 'email_verification',
            title: 'Email address verified',
            body: 'Your email address has been confirmed successfully.',
            data: { url: '/pages/guest/profile.html' },
        });
    },

    /** Read APIs, which are allowed to surface errors. */
    async list({ userId, page, limit, unreadOnly }) {
        return notificationRepository.findMany({ userId, page, limit, unreadOnly });
    },

    async countUnread(userId) {
        return notificationRepository.countUnread(userId);
    },

    async markAsRead(id, userId) {
        return notificationRepository.markAsRead(id, userId);
    },

    async markAllAsRead(userId) {
        return notificationRepository.markAllAsRead(userId);
    },

    async remove(id, userId) {
        return notificationRepository.remove(id, userId);
    },

    async clearAll(userId) {
        return notificationRepository.clearAll(userId);
    },
};

export default notificationService;