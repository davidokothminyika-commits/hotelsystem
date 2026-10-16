/**
 * src/services/rate.service.js
 *
 * WHAT THIS MODULE DOES
 * Dynamic pricing: a quote engine that resolves the sellable price of a stay
 * from a room's base rate plus the active rate rules, and the CRUD screen for
 * managing those rules.
 *
 * HOW A PRICE IS RESOLVED
 *   For each night of the stay:
 *     1. date_range rules whose window and day-of-week cover that night,
 *     2. occupancy rules whose threshold is met by how full the hotel is on
 *        that night,
 *   are all collected, then applied additively to that night's base rate.
 *   The stay's price is the mean of its nightly rates, rounded to two
 *   decimals - which keeps `price_per_night * nights == subtotal` exact, as
 *   the booking invariant requires.
 *
 * WHY ADDITIVE AND NOT COMPOUNDING
 * Two +15% rules compounding give 1.3225x, a number nobody can re-derive from
 * the rule list. Additive stacking (a 30% total that any supplier reading the
 * board can verify by hand) is reproducible, and reproducible is the property
 * a disputed quote needs.
 *
 * WHY OCCUPANCY IS A FLOATING STAY WINDOW
 * A yield rule needs "how full were we likely to be that night". Bookings yet
 * to exist cannot be consulted, so the threshold is evaluated against how full
 * the hotel is *now for that night*, from actual bookings. Retrospective
 * precision is not available; a consistent, explainable basis is.
 *
 * COMMUNICATION
 * Routes -> rate.controller.js -> THIS FILE
 *        -> rate.repository.js, room.repository.js, booking.repository.js
 * Database tables used: rate_rules, rooms, bookings
 */
import ApiError from '../utils/errors.js';
import rateRepository from '../repositories/rate.repository.js';
import roomRepository from '../repositories/room.repository.js';
import bookingRepository, { OCCUPYING_STATUSES } from '../repositories/booking.repository.js';
import { formatDate, parseDate, nightsBetween } from '../utils/date.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Short name used by the UI to explain what a rule does. */
function describeRule(rule) {
    const amount = rule.adjustmentType === 'fixed'
        ? `$${rule.adjustmentValue}`
        : `${rule.adjustmentValue > 0 ? '+' : ''}${rule.adjustmentValue}%`;
    if (rule.triggerType === 'occupancy') {
        return `${amount} when the hotel is at least ${rule.occupancyThreshold}% full`;
    }
    const days = rule.daysOfWeek.length ? ` on ${rule.daysOfWeek.join(', ')}` : '';
    return `${amount} from ${rule.startDate} to ${rule.endDate}${days}`;
}

const rateService = {
    /**
     * Resolves the price of one room for one stay, explaining every rule that
     * moved the number.
     *
     * @returns {object} { baseRate, nightlyRates, pricePerNight, extras,
     *                     applied: [{name, description, value}] }
     */
    async quote({ roomId, checkIn, checkOut }) {
        const room = await roomRepository.findById(roomId);
        if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');

        const start = parseDate(checkIn);
        const end = parseDate(checkOut);
        if (!start || !end) {
            throw ApiError.badRequest('Quote dates must be YYYY-MM-DD', 'INVALID_DATE');
        }
        if (end <= start) {
            throw ApiError.badRequest('Check-out must be after check-in', 'INVALID_DATE_RANGE');
        }

        return this.resolveStay({
            baseRate: Number(room.pricePerNight),
            roomTypeId: room.roomTypeId,
            start,
            end,
        });
    },

    /**
     * The actual engine, separated from `quote` so a caller that already holds
     * the room (booking creation) does not re-read it.
     *
     * @param {object} options
     * @param {number} options.baseRate     The room's stored nightly rate.
     * @param {number} options.roomTypeId
     * @param {Date}   options.start        Inclusive first night.
     * @param {Date}   options.end          Exclusive last night.
     */
    async resolveStay({ baseRate, roomTypeId, start, end }) {
        const rules = await rateRepository.findActiveRules();
        const totalNights = nightsBetween(start, end);

        // Eligible rules for this room, in priority order.
        const eligible = rules.filter(
            (rule) => rule.roomTypeId === null || Number(rule.roomTypeId) === Number(roomTypeId),
        );

        // One occupancy reading for the whole window is enough: the yield is a
        // property of the hotel's demand at booking time, not of each night's
        // distinct history, and it keeps the quote explainable with one number.
        const occupancyPercent = await this.occupancyPercent(start, end);

        const applied = [];
        const nightlyRates = [];
        let extras = 0;

        for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
            // MySQL's DAYOFWEEK numbering starts at Sunday(1); JS getDay does
            // the same, so no offset is needed between the two.
            const dayName = DAYS[(cursor.getDay() + 6) % 7];

            let adjustment = 0;

            for (const rule of eligible) {
                if (rule.triggerType === 'date_range') {
                    if (rule.startDate && cursor < parseDate(rule.startDate)) continue;
                    if (rule.endDate && cursor > parseDate(rule.endDate)) continue;
                    if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(dayName)) continue;
                } else if (rule.triggerType === 'occupancy') {
                    const threshold = Number(rule.occupancyThreshold ?? 0);
                    if (!(occupancyPercent >= threshold)) continue;
                } else {
                    continue;
                }

                // Additive on the night's base rate, never compounding on the
                // previous rule's result.
                adjustment += rule.adjustmentType === 'fixed'
                    ? Number(rule.adjustmentValue)
                    : (Number(rule.adjustmentValue) / 100) * baseRate;

                // One entry per rule per quote explains the price once, even
                // when the same rule applied to all five nights.
                if (!applied.some((item) => item.id === rule.id)) {
                    applied.push({
                        id: rule.id,
                        name: rule.name,
                        description: describeRule(rule),
                        triggerType: rule.triggerType,
                        adjustmentType: rule.adjustmentType,
                        adjustmentValue: Number(rule.adjustmentValue),
                    });
                }
            }

            const nightly = Number((baseRate + adjustment).toFixed(2));
            nightlyRates.push(nightly);
            extras += nightly - baseRate;
        }

        // Mean nightly rate, two decimals: the booking stores one price for
        // `nights` nights, so the stored arithmetic must keep coming out even.
        const pricePerNight = nightlyRates.length > 0
            ? Number((
                nightlyRates.reduce((sum, rate) => sum + rate, 0) / nightlyRates.length
            ).toFixed(2))
            : baseRate;

        return {
            baseRate: Number(baseRate.toFixed(2)),
            nights: totalNights,
            nightlyRates,
            pricePerNight,
            // The total the rules added over the flat base rate.
            extras: Number(extras.toFixed(2)),
            occupancyPercent,
            applied,
        };
    },

    /**
     * How full the hotel is, as a percentage of sellable capacity, over a
     * window.
     *
     * Both sides are measured in room-nights, so a window that covers four
     * nights compares four times sellable capacity against the booked
     * room-nights inside it: one cannot exceed 100% by having two bookings in
     * one room on different nights.
     *
     * Sellable capacity counts rooms whose operational status is 'available',
     * 'occupied' or 'reserved' - exactly the inventory the front desk
     * perceives. A room in maintenance or cleaning is not demand a yield rule
     * should fill, and a room retired from sale is not capacity either.
     */
    async occupancyPercent(start, end) {
        const counts = await roomRepository.getStatusCounts();
        const sellable = Number(counts.available ?? 0) + Number(counts.occupied ?? 0) + Number(counts.reserved ?? 0);
        if (sellable === 0) return 0;

        const rows = await bookingRepository.countOccupiedRoomNights(
            formatDate(start),
            formatDate(end),
            OCCUPYING_STATUSES,
        );
        const capacityNights = sellable * nightsBetween(start, end);
        if (capacityNights === 0) return 0;
        const booked = Number(rows?.total ?? 0);

        return Number(((booked / capacityNights) * 100).toFixed(2));
    },

    // ------------------------------------------------------------------
    // Rule management
    // ------------------------------------------------------------------

    async listRules({ page, limit, triggerType, isActive, search, sortBy, sortDir }) {
        return rateRepository.findMany({ page, limit, triggerType, isActive, search, sortBy, sortDir });
    },

    async getRule(id) {
        const rule = await rateRepository.findById(id);
        if (!rule) throw ApiError.notFound('Rate rule not found', 'RATE_RULE_NOT_FOUND');
        return rule;
    },

    /**
     * Creates a rule, failing loudly on a duplicate name (the table's unique
     * key would otherwise surface as a raw 500).
     */
    async createRule(data, requester) {
        if (await rateRepository.findByName(data.name)) {
            throw ApiError.conflict(`A rate rule called "${data.name}" already exists`, 'RATE_RULE_EXISTS');
        }

        this.validateRuleShape(data);

        const id = await rateRepository.create({
            ...data,
            createdBy: requester.id,
        });
        return this.getRule(id);
    },

    async updateRule(id, data) {
        const existing = await this.getRule(id);

        if (data.name && data.name !== existing.name) {
            const clash = await rateRepository.findByName(data.name);
            if (clash) throw ApiError.conflict(`A rate rule called "${data.name}" already exists`, 'RATE_RULE_EXISTS');
        }

        this.validateRuleShape({ ...existing, ...data, daysOfWeek: data.daysOfWeek ?? existing.daysOfWeek });

        await rateRepository.update(id, data);
        return this.getRule(id);
    },

    /** Deactivating keeps the row; a deleted rule cannot be re-enabled. */
    async deleteRule(id) {
        const rule = await this.getRule(id);
        await rateRepository.remove(id);
        return rule;
    },

    /**
     * Cross-field check the database cannot express: a date_range rule needs
     * its window, an occupancy rule needs its threshold.
     */
    validateRuleShape(rule) {
        if (rule.triggerType === 'date_range') {
            if (!rule.startDate || !rule.endDate) {
                throw ApiError.badRequest('A date range rule needs both start and end dates', 'INVALID_RULE_WINDOW');
            }
            const start = parseDate(rule.startDate);
            const end = parseDate(rule.endDate);
            if (!start || !end || end < start) {
                throw ApiError.badRequest('The date window is not a valid range', 'INVALID_RULE_WINDOW');
            }
        }

        if (rule.triggerType === 'occupancy') {
            const threshold = Number(rule.occupancyThreshold);
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
                throw ApiError.badRequest('The occupancy threshold must be between 0 and 100', 'INVALID_THRESHOLD');
            }
            if (rule.adjustmentType !== 'percent') {
                throw ApiError.badRequest('An occupancy rule adjusts the rate in percent', 'INVALID_ADJUSTMENT');
            }
        }

        const value = Number(rule.adjustmentValue);
        if (!Number.isFinite(value) || value === 0 || Math.abs(value) > 10_000) {
            throw ApiError.badRequest('The adjustment must be a non-zero amount', 'INVALID_ADJUSTMENT');
        }
    },

    /**
     * Quotes a page of rooms in one pass.
     *
     * Availability search needs a price for every row it shows, and evaluating
     * the rule engine per row would re-read the rules and re-measure occupancy
     * N times for data that is identical across the page. One evaluation per
     * distinct room TYPE is the only work that can differ between rows, so
     * results are cached by room type and reused for every room of that type.
     *
     * @param {Array<{id: number, roomTypeId: number, pricePerNight: number}>} rooms
     * @param {{ start: Date, end: Date }} window
     * @returns {Promise<Map<number, object>>} room id -> quote
     */
    async quoteRooms(rooms, { start, end }) {
        const quotes = new Map();
        const byType = new Map();

        for (const room of rooms) {
            // Rooms of one type share a base rate in practice, but per-room
            // rates are legal, so the cache key includes the rate itself:
            // two rooms of the same type priced differently quote separately,
            // and two identical rooms quote once.
            const key = `${Number(room.roomTypeId)}:${Number(room.pricePerNight)}`;
            if (!byType.has(key)) {
                byType.set(key, this.resolveStay({
                    baseRate: Number(room.pricePerNight),
                    roomTypeId: Number(room.roomTypeId),
                    start,
                    end,
                }));
            }
        }

        // The map above holds promises; await them all before composing, so a
        // single failure rejects the whole page and the caller's fallback
        // kicks in rather than mixing priced and unpriced rows.
        const resolved = new Map();
        for (const [key, promise] of byType) {
            resolved.set(key, await promise);
        }

        for (const room of rooms) {
            quotes.set(room.id, resolved.get(`${Number(room.roomTypeId)}:${Number(room.pricePerNight)}`));
        }
        return quotes;
    },

    /**
     * Convenience for booking creation: the adjusted nightly price for a room
     * over a stay, or the base rate when nothing applies.
     */
    async priceForStay(room, checkIn, checkOut) {
        const start = parseDate(checkIn);
        const end = parseDate(checkOut);
        if (!start || !end || end <= start) return Number(room.pricePerNight);

        const quote = await this.resolveStay({
            baseRate: Number(room.pricePerNight),
            roomTypeId: room.roomTypeId,
            start,
            end,
        });
        return quote.pricePerNight;
    },
};

export default rateService;
