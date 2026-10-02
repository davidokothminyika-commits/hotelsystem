/**
 * tests/helpers/test-server.js
 *
 * WHAT THIS MODULE DOES
 * Boots the real Express app on an ephemeral port for integration tests and
 * provides a cookie-aware HTTP client.
 *
 * WHY IT EXISTS
 * Testing against a live server catches problems a unit test never would:
 * middleware ordering, cookie flags, status codes and the actual JSON
 * contract. Starting the app in-process means the test suite is fast and does
 * not depend on a server being started separately.
 *
 * COMMUNICATION
 * Used by: tests/*.test.js
 * Reads: src/app.js and config/db.js
 * Database tables used: whatever the test exercises.
 */
// Must be the first import so NODE_ENV is set before env.js is evaluated.
import './env-setup.js';

import { createApp } from '../../src/app.js';
import { closePool, query, execute } from '../../src/config/db.js';

let server = null;
let baseUrl = null;

/**
 * Starts the app on a free port.
 * Port 0 lets the OS pick an unused port, so parallel test files cannot clash.
 */
export async function startTestServer() {
    if (server) return baseUrl;

    const app = createApp();
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });

    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    return baseUrl;
}

export async function stopTestServer() {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
        baseUrl = null;
    }
}

export function getBaseUrl() {
    return baseUrl;
}

/**
 * A minimal cookie jar.
 *
 * The real flow depends on the auth cookie travelling with each request, so
 * tests must exercise that rather than attaching an Authorization header.
 * This mimics how a browser behaves: store on Set-Cookie, resend on request.
 */
export class TestClient {
    constructor(base) {
        this.base = base || baseUrl;
        this.cookies = new Map();
    }

    /** Parses and stores Set-Cookie values. */
    storeCookies(response) {
        const raw = response.headers.getSetCookie?.() || [];
        for (const line of raw) {
            const [pair] = line.split(';');
            const index = pair.indexOf('=');
            if (index === -1) continue;
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            if (value === '') {
                this.cookies.delete(name); // an expired cookie clears the jar
            } else {
                this.cookies.set(name, value);
            }
        }
    }

    cookieHeader() {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    async request(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.json);
        }
        const cookie = this.cookieHeader();
        if (cookie) headers.Cookie = cookie;

        const response = await fetch(`${this.base}${path}`, { ...options, headers });
        this.storeCookies(response);

        const text = await response.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text; // non-JSON response, e.g. an HTML error page
        }

        return { status: response.status, body, headers: response.headers };
    }

    get(path, options) {
        return this.request(path, { ...options, method: 'GET' });
    }

    post(path, json, options) {
        return this.request(path, { ...options, method: 'POST', json });
    }

    patch(path, json, options) {
        return this.request(path, { ...options, method: 'PATCH', json });
    }

    put(path, json, options) {
        return this.request(path, { ...options, method: 'PUT', json });
    }

    delete(path, options) {
        return this.request(path, { ...options, method: 'DELETE' });
    }
}

/**
 * Creates a client and signs it in as one of the seeded demo accounts.
 * Returns both so tests can make authorised calls.
 */
export async function loginAs(email, password) {
    const client = new TestClient();
    const result = await client.post('/api/auth/login', { email, password });
    if (result.status !== 200) {
        throw new Error(`Login failed for ${email}: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return { client, user: result.body.data.user };
}

/** Removes rows created by a test, in an order that respects foreign keys. */
export async function cleanupTables(tables) {
    await execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
        await execute(`TRUNCATE TABLE ${table}`);
    }
    await execute('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * Deletes bookings that a previous test run left behind.
 *
 * WHY THIS IS NEEDED
 * Booking tests deliberately consume rooms for future dates. Running the
 * suite repeatedly against the same database would slowly fill every room
 * until no room is free and the suite fails for reasons unrelated to the code
 * under test.
 *
 * Only bookings with the automated test marker are removed, so real data and
 * the seeded sample bookings are never touched. `special_requests` is used as
 * the marker because it is written by every booking the tests create.
 *
 * @param {number} [olderThanHours] Safety window: only clean rows at least
 *   this old, so a concurrently running suite is never disturbed.
 */
export async function cleanTestBookings(olderThanHours = 0) {
    await execute(
        `DELETE FROM bookings
         WHERE special_requests = 'Automated test booking'
           AND created_at < DATE_SUB(NOW(), INTERVAL :hours HOUR)`,
        { hours: olderThanHours },
    );
}

/**
 * Resets room status so a failed run cannot leave rooms stuck in a state that
 * excludes them from availability searches.
 */
export async function resetRoomStatuses() {
    await execute(
        `UPDATE rooms r SET r.status = 'available'
         WHERE r.status IN ('cleaning', 'maintenance')
           AND NOT EXISTS (
               SELECT 1 FROM bookings b
               WHERE b.room_id = r.id AND b.status = 'checked_in'
           )`,
    );
}

/**
 * Runs a SELECT and returns rows.
 *
 * Tests need this because `execute` returns a driver result object while
 * `query` returns rows. Using the wrong one silently yields `undefined`,
 * so it is re-exported under a clearer name.
 */
export async function select(sql, params = {}) {
    return query(sql, params);
}

export { query, execute, closePool };