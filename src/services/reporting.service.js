/**
 * src/services/reporting.service.js
 *
 * WHAT THIS MODULE DOES
 * Builds the finance report: a tax summary for a date range and the daily
 * revenue audit that reconciles billed money against collected money, day by
 * day.
 *
 * WHY IT EXISTS
 * Two accounting bases meet in this report and they are easy to conflate:
 *
 *   ACCRUAL (tax summary)  - invoices issued in the range. This is what the
 *     hotel billed and therefore what it owes in VAT and service charge.
 *     An invoice is only ever issued once a payment completes (see
 *     payment.service.js), so this is billed revenue, not speculative quotes.
 *
 *   CASH (payments)        - money that actually moved in the range:
 *     completed payments against refunded ones, grouped by the day they
 *     settled. A refund is booked on the day it was issued, which means it
 *     can sit in a different period than the original charge. That is
 *     intentional and is what an auditor expects to see.
 *
 * The daily rows carry both bases next to each other - billed, tax, collected,
 * refunded, net - so the question "why is cash not equal to billing today?"
 * has an answer on screen instead of in a spreadsheet.
 *
 * RANGE RULES (re-checked here even though the route validates them)
 *   - bounds default to the last 30 days ending today
 *   - `from` must be on or before `to`
 *   - the window may not exceed 366 days, so one request cannot ask the
 *     database to aggregate an unbounded ledger
 *
 * COMMUNICATION
 * Browser -> GET /api/reports/finance -> report.controller.js -> THIS FILE
 *        -> report.repository.js -> MySQL (invoices, payments)
 * Reads rates from: src/config/pricing.js
 */
import ApiError from '../utils/errors.js';
import { PRICING } from '../config/pricing.js';
import { parseDate, formatDate, today, addDays, differenceInDays } from '../utils/date.js';
import reportRepository from '../repositories/report.repository.js';

/** Window used when the caller gives no range: the last 30 days, inclusive. */
const DEFAULT_RANGE_DAYS = 30;
/** Hard ceiling on the range, mirroring the validator. */
const MAX_RANGE_DAYS = 366;

/** Every method a payment can settle through, so none is ever missing. */
const PAYMENT_METHODS = Object.freeze(['card', 'mobile_money', 'cash']);

/** Coerces a DECIMAL (returned as a string by mysql2) to a JS number. */
const num = (value) => Number(value ?? 0);

/** Coerces to a number rounded to cents; keeps printed totals additive. */
const money = (value) => Number(num(value).toFixed(2));

/** Parses an optional 'YYYY-MM-DD' bound, rejecting impossible dates. */
function parseBound(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = parseDate(String(value));
    if (!parsed) {
        throw ApiError.badRequest(`${field} must be a valid date in YYYY-MM-DD format`, 'INVALID_DATE');
    }
    return parsed;
}

/** The zero shape used for both revenue sources. */
function emptySourceTotals() {
    return { invoicesIssued: 0, subtotal: 0, tax: 0, serviceCharge: 0, totalInvoiced: 0 };
}

const reportingService = {
    /**
     * Tax summary and daily revenue audit for an inclusive date range.
     *
     * @param {object} [options]
     * @param {string} [options.from] 'YYYY-MM-DD', defaults to 29 days before `to`.
     * @param {string} [options.to]   'YYYY-MM-DD', defaults to today.
     * @returns {Promise<object>} the report shape documented in report.controller.js
     */
    async getFinanceReport({ from, to } = {}) {
        const end = parseBound(to, 'To') || today();
        const start = parseBound(from, 'From') || addDays(end, -(DEFAULT_RANGE_DAYS - 1));

        if (start > end) {
            throw ApiError.badRequest('From must be on or before To', 'INVALID_RANGE');
        }
        if (differenceInDays(end, start) + 1 > MAX_RANGE_DAYS) {
            throw ApiError.badRequest(`Range must not exceed ${MAX_RANGE_DAYS} days`, 'RANGE_TOO_LARGE');
        }

        const range = { from: formatDate(start), to: formatDate(end) };

        const [
            invoices,
            bySource,
            byMethod,
            refunds,
            dailyInvoices,
            dailyCompleted,
            dailyRefunded,
        ] = await Promise.all([
            reportRepository.invoiceTotals(range),
            reportRepository.invoiceTotalsBySource(range),
            reportRepository.completedPaymentsByMethod(range),
            reportRepository.refundedTotals(range),
            reportRepository.dailyInvoices(range),
            reportRepository.dailyCompletedPayments(range),
            reportRepository.dailyRefundedPayments(range),
        ]);

        // ---- Tax summary (accrual) ------------------------------------
        const sourceTotals = { rooms: emptySourceTotals(), food: emptySourceTotals() };
        for (const row of bySource) {
            const bucket = sourceTotals[row.source];
            if (!bucket) continue;
            bucket.invoicesIssued = num(row.invoices_issued);
            bucket.subtotal = money(row.subtotal);
            bucket.tax = money(row.tax);
            bucket.serviceCharge = money(row.service_charge);
            bucket.totalInvoiced = money(row.total_invoiced);
        }

        // ---- Collections (cash) ---------------------------------------
        const collectedByMethod = Object.fromEntries(PAYMENT_METHODS.map((method) => [method, 0]));
        let collected = 0;
        let collectedCount = 0;
        for (const row of byMethod) {
            if (!(row.payment_method in collectedByMethod)) continue;
            collectedByMethod[row.payment_method] = money(row.amount);
            collected += num(row.amount);
            collectedCount += num(row.txn_count);
        }
        const refunded = money(refunds?.amount);
        const refundedCount = num(refunds?.txn_count);

        // ---- Daily audit rows -----------------------------------------
        // Every day in the range appears, including empty ones: a gap in a
        // ledger reads as missing data, and a zero row reads as "nothing
        // happened", which are very different claims.
        const invoicesByDay = new Map(dailyInvoices.map((row) => [row.day, row]));
        const completedByDay = new Map(dailyCompleted.map((row) => [row.day, row]));
        const refundedByDay = new Map(dailyRefunded.map((row) => [row.day, row]));

        const daily = [];
        for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
            const key = formatDate(day);
            const billed = invoicesByDay.get(key);
            const received = completedByDay.get(key);
            const returned = refundedByDay.get(key);

            const dayCollected = money(received?.amount);
            const dayRefunded = money(returned?.amount);

            daily.push({
                date: key,
                invoicesIssued: num(billed?.invoices_issued),
                invoiced: money(billed?.total_invoiced),
                tax: money(billed?.tax),
                collected: dayCollected,
                refunded: dayRefunded,
                net: money(dayCollected - dayRefunded),
            });
        }

        return {
            range,
            pricing: {
                currency: PRICING.currency,
                taxRate: PRICING.taxRate,
                serviceChargeRate: PRICING.serviceChargeRate,
            },
            tax: {
                invoicesIssued: num(invoices?.invoices_issued),
                subtotal: money(invoices?.subtotal),
                tax: money(invoices?.tax),
                serviceCharge: money(invoices?.service_charge),
                totalInvoiced: money(invoices?.total_invoiced),
                balanceDue: money(invoices?.balance_due),
                openInvoices: num(invoices?.open_invoices),
                rooms: sourceTotals.rooms,
                food: sourceTotals.food,
            },
            payments: {
                collected: money(collected),
                collectedCount,
                refunded,
                refundedCount,
                net: money(collected - refunded),
                byMethod: collectedByMethod,
            },
            daily,
        };
    },
};

export default reportingService;
