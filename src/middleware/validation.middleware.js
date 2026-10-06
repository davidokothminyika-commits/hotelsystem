/**
 * src/middleware/validation.middleware.js
 *
 * WHAT THIS MODULE DOES
 * Runs express-validator rule chains and turns any failures into a single
 * 422 response with a field -> message map.
 *
 * WHY IT EXISTS
 * Validation logic should be declared next to the route it protects, so a
 * developer reading `POST /api/auth/register` immediately sees the required
 * fields and their rules. This middleware is the piece that executes those
 * declarations consistently.
 *
 * WHY VALIDATE IN THE SERVICE TOO
 * Express validators protect the HTTP boundary. The service re-checks the
 * rules it depends on because services can also be called from other services,
 * seed scripts and tests. Defence in depth is cheap here; a missed validation
 * on an internal call is a data integrity bug.
 *
 * COMMUNICATION
 * Used by: route files, as `validate(createBookingRules)`.
 * Reads:   rule definitions in src/validators/.
 * Database tables used: none.
 */
import { validationResult, matchedData } from 'express-validator';
import ApiError from '../utils/errors.js';

/**
 * @param {import('express-validator').ValidationChain[]} rules
 * @param {'body'|'query'|'params'} [source='body'] Which part to validate.
 */
export function validate(rules, source = 'body') {
    return async function validationMiddleware(req, res, next) {
        try {
            // Recorded BEFORE the rules run. A sanitiser such as .trim() writes
            // an empty string into a field the client never sent, which would
            // make "cleared this value" indistinguishable from "did not mention
            // this field". A partial update has to be able to tell them apart,
            // so the keys that actually arrived are captured here.
            const provided = new Set(Object.keys(req[source] || {}));

            // Execute every declared chain, collecting failures rather than
            // stopping at the first one, so the client can highlight all
            // invalid fields in a single round trip.
            await Promise.all(rules.map((chain) => chain.run(req)));

            const result = validationResult(req);
            if (!result.isEmpty()) {
                const details = {};
                for (const error of result.array()) {
                    // Keep only the first message per field.
                    const field = error.path ?? error.param;
                    if (!details[field]) details[field] = error.msg;
                }
                throw ApiError.unprocessable('Please correct the highlighted fields', details);
            }

            // `matchedData` returns only the fields that were actually declared
            // in the rule chains, with sanitised values (trimmed, coerced to
            // the declared type). Controllers read req.validated.source
            // instead of req.source, so a client cannot smuggle an unexpected
            // extra key into a query.
            req.validated = {
                ...(req.validated || {}),
                [source]: matchedData(req, { locations: [source], includeOptionals: false }),
            };

            // Companion to req.validated: the same fields, but only those the
            // client really sent. Endpoints that treat a request as a partial
            // update read this; a full-replace endpoint can ignore it.
            req.provided = {
                ...(req.provided || {}),
                [source]: provided,
            };

            return next();
        } catch (error) {
            return next(error);
        }
    };
}

export default { validate };