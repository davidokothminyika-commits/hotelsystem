/**
 * src/repositories/base.repository.js
 *
 * WHAT THIS MODULE DOES
 * Provides the small set of database helpers every repository needs.
 *
 * WHY IT EXISTS
 * Each repository would otherwise repeat the same `query`/`queryOne`/`execute`
 * imports, and more importantly each would repeat the same mistakes around
 * dynamic SQL. Centralising the dynamic parts here means a reviewer only has
 * to check this one file to confirm that user input can never be concatenated
 * into SQL text.
 *
 * THE SQL INJECTION RULE ENFORCED HERE
 *   ALLOWED to come from code: table names, column names and sort directions
 *                                  that appear in an allow list in the caller.
 *   NEVER allowed to come from a user: any value, filter, search term or id.
 *
 * A user-supplied search term is always passed as a bound parameter
 * (`:term`), which mysql2 sends separately from the SQL text. It is never
 * placed in the string with template literals.
 *
 * COMMUNICATION
 * Used by: every repository in this folder.
 * Reads: config/db.js for the connection pool.
 * Database tables used: depends on the calling repository.
 */

/**
 * Builds a WHERE clause from a set of conditions, ANDed together.
 *
 * @param {Array<{ sql: string, params: object }>} conditions
 *   Each `sql` fragment must use named placeholders, e.g.
 *   `'status = :status'` with `{ status: 'confirmed' }`.
 * @returns {{ clause: string, params: object }}
 */
export function buildWhere(conditions) {
    const active = conditions.filter(Boolean);
    if (active.length === 0) return { clause: '', params: {} };

    const clause = active.map((condition) => condition.sql).join(' AND ');
    const params = Object.assign({}, ...active.map((condition) => condition.params ?? {}));
    return { clause: `WHERE ${clause}`, params };
}

/**
 * Resolves pagination values into safe LIMIT/OFFSET numbers.
 * Values are coerced to integers because MySQL will reject a string LIMIT.
 */
export function resolvePagination({ page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const rawLimit = Number.parseInt(limit, 10) || 20;
    // Cap the page size so a single request cannot ask for the whole table.
    const safeLimit = Math.min(100, Math.max(1, rawLimit));
    return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

/**
 * Sorting is the most common injection vector in a hand written API, because
 * `ORDER BY ?` cannot take a bound parameter. The direction is therefore
 * whitelisted, never passed through.
 */
export function resolveSort(sortBy, sortDir, allowedColumns, fallback) {
    const column = allowedColumns.includes(sortBy) ? sortBy : fallback;
    const direction = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return { column, direction };
}

/**
 * Common repository behaviour shared by every table.
 * Concrete repositories extend this and expose intent named methods such as
 * `findByEmail` rather than a generic `findOne`, so controllers read clearly.
 */
export class BaseRepository {
    constructor(tableName) {
        this.table = tableName;
    }
}

export default BaseRepository;