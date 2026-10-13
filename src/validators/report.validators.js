/**
 * src/validators/report.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for reporting queries, starting with the finance report's
 * date range.
 *
 * WHY IT EXISTS
 * The range is the one thing a client controls about a report, and an
 * unbounded range is a denial of service dressed as a feature: asking for
 * every day since 2000 forces the database to aggregate the whole ledger on
 * every request. The format and the span are therefore checked at the HTTP
 * boundary, and re-checked in the service for calls that never pass through
 * here.
 *
 * COMMUNICATION
 * Used by: src/routes/reports.routes.js
 * Database tables used: none.
 */
import { query } from 'express-validator';

/** Longest window a single report may cover, in days. Mirrored in the service. */
export const MAX_RANGE_DAYS = 366;

/** An optional YYYY-MM-DD query parameter. */
const optionalDate = (field, label) =>
    query(field)
        .optional()
        .isISO8601({ strict: true })
        .withMessage(`${label} must be a valid date in YYYY-MM-DD format`);

export const financeReportRules = [
    optionalDate('from', 'From'),
    // The cross-field checks live on `to` because both bounds are only
    // meaningful together. `bail()` keeps a malformed `to` from also
    // producing a confusing "From must be on or before To" alongside it.
    query('to')
        .optional()
        .isISO8601({ strict: true })
        .withMessage('To must be a valid date in YYYY-MM-DD format')
        .bail()
        .custom((value, { req }) => {
            const from = req.query.from;
            if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
                return true; // absent or already rejected by the format rule
            }

            const start = Date.parse(from);
            const end = Date.parse(value);
            if (Number.isNaN(start) || Number.isNaN(end)) return true; // format rule reports it

            if (start > end) {
                throw new Error('From must be on or before To');
            }
            if (end - start > (MAX_RANGE_DAYS - 1) * 86_400_000) {
                throw new Error(`Range must not exceed ${MAX_RANGE_DAYS} days`);
            }
            return true;
        }),
];
