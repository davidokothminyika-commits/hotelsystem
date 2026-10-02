/**
 * src/utils/date.js
 *
 * WHAT THIS MODULE DOES
 * Date helpers used by booking availability, invoice numbering and reports.
 *
 * WHY IT EXISTS
 * Availability checks are date-range comparisons that appear in several
 * services. Getting the boundary conditions right in one place prevents bugs
 * such as treating a checkout day as a night, or off-by-one errors when
 * counting nights.
 *
 * KEY RULE
 * A booking occupies nights, not days. A guest checking in on the 10th and
 * out on the 12th occupies the nights of the 10th and 11th, so the room is
 * free again on the 12th. Two bookings overlap when:
 *     existing.check_in < requested.check_out AND existing.check_out > requested.check_in
 *
 * COMMUNICATION
 * Used by: services/booking.service.js, services/reporting.service.js.
 * Database tables used: none (pure functions).
 */

/** Parses 'YYYY-MM-DD' into a local Date at midnight, avoiding UTC shifting. */
export function parseDate(value) {
    if (value instanceof Date) return value;
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    // Reject impossible dates such as 2025-02-30 which roll over silently.
    if (
        date.getFullYear() !== Number(year) ||
        date.getMonth() !== Number(month) - 1 ||
        date.getDate() !== Number(day)
    ) {
        return null;
    }
    return date;
}

/** Formats a Date as 'YYYY-MM-DD' in local time. */
export function formatDate(date) {
    const value = date instanceof Date ? date : new Date(date);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Midnight today, local time. */
export function today() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Adds whole days to a Date. */
export function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

/** Whole days between two dates, ignoring time of day. */
export function differenceInDays(later, earlier) {
    const a = new Date(later.getFullYear(), later.getMonth(), later.getDate());
    const b = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
    return Math.round((a - b) / 86_400_000);
}

/**
 * Number of nights a guest is charged for.
 * Checkout on the same day as check-in is rejected earlier in validation,
 * so a positive result is guaranteed here.
 */
export function nightsBetween(checkIn, checkOut) {
    return Math.max(1, differenceInDays(checkOut, checkIn));
}

/**
 * True when two half-open date ranges [aStart, aEnd) and [bStart, bEnd)
 * overlap. A checkout day never collides with the next check-in day, so
 * back-to-back bookings for the same room are allowed.
 */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
}

/** Start of the current week (Monday). */
export function startOfWeek(date = new Date()) {
    const result = new Date(date);
    const day = (result.getDay() + 6) % 7; // Monday = 0
    result.setDate(result.getDate() - day);
    result.setHours(0, 0, 0, 0);
    return result;
}

/** Start of the current month. */
export function startOfMonth(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Turns a named report period into concrete start/end dates.
 * @param {'today'|'week'|'month'|'all'} period
 * @returns {{ start: Date, end: Date }}
 */
export function resolvePeriod(period = 'month') {
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    switch (period) {
        case 'today': {
            const start = today();
            return { start, end };
        }
        case 'week':
            return { start: startOfWeek(), end };
        case 'month':
            return { start: startOfMonth(), end };
        case 'all':
        default:
            return { start: new Date(2000, 0, 1), end };
    }
}

export default {
    parseDate,
    formatDate,
    today,
    addDays,
    differenceInDays,
    nightsBetween,
    rangesOverlap,
    startOfWeek,
    startOfMonth,
    resolvePeriod,
};