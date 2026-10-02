/**
 * src/utils/json.js
 *
 * WHAT THIS MODULE DOES
 * Safely converts a MySQL JSON column value into a JavaScript value.
 *
 * WHY THIS EXISTS
 * mysql2 automatically parses JSON columns into objects and arrays when it
 * receives them as strings, but the behaviour depends on how the value is
 * produced and on the connection settings. A `JSON_ARRAYAGG` subquery result,
 * for example, arrives already parsed as an array, while a value echoed back
 * from a JSON column may arrive as a string.
 *
 * Calling `JSON.parse` on an already-parsed object throws
 * "Unexpected token 'o', [object Object] is not valid JSON", which is a
 * confusing error for what is really a type mismatch. Every repository that
 * reads a JSON column therefore goes through this helper instead of calling
 * JSON.parse directly.
 *
 * COMMUNICATION
 * Used by: repositories that read `metadata`, `data`, `provider_response`
 *           and the `amenities` aggregate column.
 * Database tables used: none (pure helper).
 */

/**
 * Normalises a JSON column value.
 *
 * @param {unknown} value Raw value from the driver.
 * @param {*} [fallback=null] Returned when the value is null or unusable.
 * @returns {*} The parsed value, the original value, or the fallback.
 */
export function parseJsonColumn(value, fallback = null) {
    if (value === null || value === undefined) return fallback;

    // Already an object or array: mysql2 already parsed it for us.
    if (typeof value === 'object') return value;

    // A Buffer from a BLOB-backed JSON column; convert to text first.
    if (Buffer.isBuffer(value)) {
        try {
            return JSON.parse(value.toString('utf8'));
        } catch {
            return fallback;
        }
    }

    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            // Not valid JSON. Return the raw string rather than throwing,
            // so a malformed stored value cannot break an entire listing.
            return value;
        }
    }

    // Numbers, booleans and anything else are returned untouched.
    return value;
}

export default parseJsonColumn;