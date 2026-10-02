/**
 * src/config/db.js
 *
 * WHAT THIS MODULE DOES
 * Creates and exports a mysql2 connection pool. Every repository uses this
 * pool, so the app holds a small fixed number of database connections instead
 * of opening a new one per query.
 *
 * WHY IT EXISTS
 * Connection setup, error handling and transaction helpers live in one place.
 * Repositories stay focused on SQL, and swapping the database later only means
 * editing this file.
 *
 * COMMUNICATION
 * Used by: every file in src/repositories, and src/database/seed.js.
 * Reads: env.js for connection settings.
 * Database tables used: none directly (it only manages connections).
 */
import mysql from 'mysql2/promise';
import env from './env.js';

/**
 * The pool. `waitForConnections` queues requests rather than throwing when
 * every connection is busy, and `namedPlaceholders` lets repositories write
 * `:name` placeholders instead of bare `?`.
 */
export const pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    connectionLimit: env.db.connectionLimit,
    queueLimit: 0,
    namedPlaceholders: true,
    charset: 'utf8mb4_unicode_ci',
    /**
     * DATE and DATETIME columns are returned as 'YYYY-MM-DD' and
     * 'YYYY-MM-DD HH:MM:SS' strings instead of JavaScript Date objects.
     *
     * WHY THIS MATTERS
     * A booking check-in date is a calendar date, not an instant in time. If
     * mysql2 returns it as a Date, the driver interprets it in the session
     * timezone and then converts it to UTC, so a guest checking in on the
     * 11th can be shown the 10th in any timezone offset behind UTC. The date
     * silently shifts, which is exactly the class of bug that produces
     * "wrong night" complaints at the front desk.
     *
     * Keeping the raw string means the value returned by the database is the
     * value the application works with. Callers that need a Date use the
     * date helpers in src/utils/date.js, which parse in local time
     * deliberately.
     */
    dateStrings: true,
});

/**
 * Runs a SELECT and returns the rows.
 *
 * NEVER build SQL by concatenating user input. Always pass values through
 * the params object, e.g. `query('SELECT * FROM rooms WHERE id = :id', { id })`.
 *
 * @param {string} sql
 * @param {object} [params]
 */
export async function query(sql, params = {}) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * Runs an INSERT/UPDATE/DELETE. Returns the driver result so callers can
 * read `insertId` and `affectedRows`.
 */
export async function execute(sql, params = {}) {
    const [result] = await pool.execute(sql, params);
    return result;
}

/**
 * Returns a single row or null.
 */
export async function queryOne(sql, params = {}) {
    const rows = await query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Runs a callback inside a database transaction.
 *
 * WHY THIS EXISTS
 * Some operations touch several tables at once, for example creating a
 * booking must insert into `bookings`, `invoices` and `notifications`. If the
 * second insert fails, the first must be rolled back, otherwise the hotel
 * ends up with a half-created booking.
 *
 * HOW IT WORKS
 *   - acquires one dedicated connection from the pool
 *   - BEGIN  -> run the callback -> COMMIT on success
 *   - ROLLBACK if the callback throws, then re-throw
 *   - always releases the connection back to the pool
 *
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<any>} callback
 * @example
 *   const result = await withTransaction(async (conn) => {
 *       const [booking] = await conn.execute('INSERT INTO bookings ...');
 *       return booking;
 *   });
 */
export async function withTransaction(callback) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch {
            // The connection is already broken; the pool will discard it.
        }
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Verifies the database is reachable. Called once on server boot so a bad
 * configuration is reported immediately instead of on the first request.
 */
export async function testConnection() {
    const connection = await pool.getConnection();
    try {
        await connection.ping();
        return true;
    } finally {
        connection.release();
    }
}

/**
 * Closes every pooled connection. Used by the seed script and on shutdown.
 */
export async function closePool() {
    await pool.end();
}

export default pool;