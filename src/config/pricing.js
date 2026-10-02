/**
 * src/config/pricing.js
 *
 * WHAT THIS MODULE DOES
 * Single source of truth for money: tax rate, service charge, currency and
 * the total calculation used by bookings, orders, invoices and reports.
 *
 * WHY IT IS ITS OWN FILE
 * It started inside booking.service.js, but the notification service also
 * needs to format money for display, and booking imports notifications. That
 * created a circular import between two services, which is fragile because
 * module initialisation order determines which binding is defined at the time
 * it is read. A leaf config module with no imports breaks the cycle cleanly.
 *
 * WHY IT LIVES IN config/ RATHER THAN A DATABASE TABLE
 * The brief asks for a self-contained local system. Rates are still declared in
 * exactly one place, so moving them into a settings table later is a change to
 * this file alone.
 *
 * COMMUNICATION
 * Used by: booking.service.js, order.service.js, payment.service.js,
 *           invoice.service.js, notification.service.js, reporting.service.js
 * Database tables used: none (pure configuration and arithmetic).
 */
export const PRICING = Object.freeze({
    taxRate: 0.16, // 16% VAT
    serviceChargeRate: 0.10, // 10% service charge
    currency: 'USD',
    /** Minimum lead time in days before arrival. */
    minimumLeadDays: 0,
    /** Longest stay permitted in a single reservation. */
    maximumNights: 30,
    /** Free cancellation window in days before check-in. */
    freeCancellationDays: 2,
});

/**
 * Splits a subtotal into its tax, service charge and total.
 *
 * Each component is rounded to 2 decimal places independently. Rounding only
 * the final total would produce figures where the printed lines do not add up
 * to the printed total, which is exactly the kind of discrepancy that makes a
 * guest distrust a bill.
 *
 * @param {number} subtotal The amount before tax and service charge.
 * @returns {{ subtotal: number, taxAmount: number, serviceCharge: number, totalAmount: number }}
 */
export function calculateTotals(subtotal) {
    const base = Number(subtotal) || 0;
    const taxAmount = Number((base * PRICING.taxRate).toFixed(2));
    const serviceCharge = Number((base * PRICING.serviceChargeRate).toFixed(2));
    const totalAmount = Number((base + taxAmount + serviceCharge).toFixed(2));

    return { subtotal: Number(base.toFixed(2)), taxAmount, serviceCharge, totalAmount };
}

/** Formats an amount for display, e.g. "USD 145.00". */
export function formatMoney(amount, currency = PRICING.currency) {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

export default PRICING;