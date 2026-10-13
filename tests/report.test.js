/**
 * tests/report.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for GET /api/reports/finance - the tax summary and daily
 * revenue audit.
 *
 * WHY IT EXISTS
 * A finance report that looks plausible is worse than one that fails loudly.
 * These tests check the money itself: that the daily rows add back up to the
 * summary they sit under, that the rooms and food splits add up to the total,
 * that the VAT figure is bounded by what 16% rounding can legitimately
 * produce, and that a payment made during the run actually lands on its day.
 * They also pin the access rule, because a finance endpoint that leaks to
 * guests is a security bug, not a UX one.
 *
 * RUN
 *   npm test
 *
 * COMMUNICATION
 * Uses: tests/helpers/test-server.js to boot the real app in-process.
 * Database tables used: invoices, payments, bookings, rooms, users.
 */
import './helpers/env-setup.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startTestServer,
    stopTestServer,
    TestClient,
    loginAs,
    select,
    cleanTestBookings,
    resetRoomStatuses,
    testBookingMarker,
    closePool,
} from './helpers/test-server.js';

/** Documented in the payments UI and used by the seeded mock gateway. */
const CARD_SUCCESS = '4242424242424242';

// Unique to this run, so the startup cleanup reclaims every earlier run's
// bookings without deleting ones a concurrently running suite is using.
const RUN_MARKER = testBookingMarker();

before(async () => {
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    await stopTestServer();
    await closePool();
});

const sessions = new Map();

/** Memoised sign-in: bcrypt at cost 12 makes repeated logins expensive. */
async function as(email, password) {
    if (!sessions.has(email)) {
        const { client } = await loginAs(email, password);
        sessions.set(email, client);
    }
    return sessions.get(email);
}

const admin = () => as('admin@example.com', 'Admin@1234');
const manager = () => as('manager@example.com', 'Manager@1234');
const reception = () => as('reception@example.com', 'Reception@1234');
const guest = () => as('guest@example.com', 'Guest@1234');

function dateOnly(daysFromNow) {
    return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/** Money cross-checks tolerate a cent: the sums are separate SQL GROUP BYs. */
function approx(actual, expected, tolerance = 0.011, label = '') {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label} expected ~${expected}, got ${actual}`,
    );
}

const sum = (rows, key) => rows.reduce((acc, row) => acc + Number(row[key] || 0), 0);

describe('Finance report: access control', () => {
    test('an anonymous request is rejected', async () => {
        const { status } = await new TestClient().get('/api/reports/finance');
        assert.equal(status, 401);
    });

    test('a guest cannot read the finance report', async () => {
        const { status, body } = await (await guest()).get('/api/reports/finance');
        assert.equal(status, 403, body?.message);
    });

    test('a receptionist without report:read cannot read it either', async () => {
        const { status, body } = await (await reception()).get('/api/reports/finance');
        assert.equal(status, 403, body?.message);
    });

    test('a manager gets the full report shape', async () => {
        const { status, body } = await (await manager()).get('/api/reports/finance');
        assert.equal(status, 200, body?.message);

        const report = body.data.report;
        assert.ok(report.range.from && report.range.to, 'the range actually used is returned');
        assert.equal(report.pricing.taxRate, 0.16);
        assert.equal(report.pricing.serviceChargeRate, 0.1);
        assert.equal(report.pricing.currency, 'USD');
        assert.ok(Array.isArray(report.daily));
        // No range given: the server default is the last 30 days, inclusive.
        assert.equal(report.daily.length, 30);
        for (const method of ['card', 'mobile_money', 'cash']) {
            assert.ok(method in report.payments.byMethod, `method ${method} is reported`);
        }
        assert.ok('rooms' in report.tax && 'food' in report.tax, 'revenue is split by source');
    });

    test('an administrator gets the report too', async () => {
        const { status, body } = await (await admin()).get('/api/reports/finance');
        assert.equal(status, 200, body?.message);
        assert.ok(body.data.report.range.from);
    });
});

describe('Finance report: range validation', () => {
    test('a malformed from date is rejected', async () => {
        const { status, body } = await (await manager()).get('/api/reports/finance?from=13-10-2026');
        assert.equal(status, 422);
        assert.ok(body.errors?.from, 'the field error is named');
    });

    test('from after to is rejected', async () => {
        const { status, body } = await (await manager()).get(
            `/api/reports/finance?from=${dateOnly(5)}&to=${dateOnly(1)}`,
        );
        assert.equal(status, 422);
        assert.ok(body.errors?.to);
    });

    test('a range longer than 366 days is rejected', async () => {
        const { status, body } = await (await manager()).get(
            `/api/reports/finance?from=${dateOnly(-400)}&to=${dateOnly(0)}`,
        );
        assert.equal(status, 422);
        assert.ok(body.errors?.to);
    });
});

describe('Finance report: figures reconcile', () => {
    test('daily rows add back up to their own summary', async () => {
        const { status, body } = await (await manager()).get('/api/reports/finance');
        assert.equal(status, 200, body?.message);

        const { range, tax, payments, daily } = body.data.report;

        // One row per day, unique and in order - a gap would read as data loss.
        assert.equal(daily.length, 30);
        const dates = daily.map((row) => row.date);
        assert.deepEqual([...dates].sort(), dates, 'daily rows must be ordered');
        assert.equal(new Set(dates).size, dates.length, 'daily rows must be unique');
        assert.equal(dates[dates.length - 1], range.to);

        // Accrual: the day rows sum to the tax summary above them.
        approx(sum(daily, 'invoiced'), tax.totalInvoiced, 0.011, 'daily billed vs summary');
        approx(sum(daily, 'tax'), tax.tax, 0.011, 'daily tax vs summary');
        approx(sum(daily, 'invoicesIssued'), tax.invoicesIssued, 0.001, 'daily invoice count');

        // Cash: same for collections, refunds and the method split.
        approx(sum(daily, 'collected'), payments.collected, 0.011, 'daily collected vs summary');
        approx(sum(daily, 'refunded'), payments.refunded, 0.011, 'daily refunded vs summary');
        approx(sum(daily, 'net'), payments.net, 0.011, 'daily net vs summary');
        approx(
            Object.values(payments.byMethod).reduce((a, b) => a + b, 0),
            payments.collected,
            0.011,
            'methods vs collected',
        );
        approx(payments.collected - payments.refunded, payments.net, 0.011, 'net arithmetic');

        // Source split: rooms plus food is the whole pie.
        approx(tax.rooms.subtotal + tax.food.subtotal, tax.subtotal, 0.011, 'source split');
        approx(tax.rooms.tax + tax.food.tax, tax.tax, 0.011, 'source tax split');
        approx(
            tax.rooms.totalInvoiced + tax.food.totalInvoiced,
            tax.totalInvoiced,
            0.011,
            'source invoiced split',
        );

        // VAT: 16% of the subtotal, within what per-invoice cent rounding can
        // produce. A larger gap means the rate and the stored figures disagree.
        assert.ok(
            Math.abs(tax.tax - tax.subtotal * 0.16) <= tax.invoicesIssued * 0.01 + 0.011,
            `VAT ${tax.tax} is not consistent with 16% of ${tax.subtotal}`,
        );
    });

    test('a payment made now appears on its own day', async () => {
        // Book and pay, exactly as a guest would, so the report is measured
        // against a transaction this run created rather than seed data.
        const booking = await createBookableBooking();

        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Report Test',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });
        assert.equal(paid.status, 201, paid.body?.message);

        const amount = Number(paid.body.data.payment.amount);
        const [paymentRow] = await select('SELECT DATE(paid_at) AS day FROM payments WHERE id = :id', {
            id: paid.body.data.payment.id,
        });
        assert.match(paymentRow.day, /^\d{4}-\d{2}-\d{2}$/);

        // Query exactly the day the money settled - no timezone guessing.
        const { status, body } = await (await manager()).get(
            `/api/reports/finance?from=${paymentRow.day}&to=${paymentRow.day}`,
        );
        assert.equal(status, 200, body?.message);

        const report = body.data.report;
        const row = report.daily.find((entry) => entry.date === paymentRow.day);
        assert.ok(row, `day ${paymentRow.day} must appear in the audit rows`);
        assert.equal(report.daily.length, 1);        assert.ok(row.collected + 0.011 >= amount,
            `day collected ${row.collected} must cover the ${amount} payment`,
        );

        assert.ok(report.payments.collected + 0.011 >= amount);
        assert.ok(row.invoiced + 0.011 >= Number(booking.totalAmount));
        assert.ok(report.tax.invoicesIssued >= 1, 'the payment issued an invoice');
        assert.ok(row.tax > 0, 'the invoice carried VAT');
    });
});

// ---------------------------------------------------------------------------
// Booking helper (mirrors tests/payment.test.js, with two deliberate
// differences so the suites do not fight each other)
// ---------------------------------------------------------------------------

/**
 * Windows this suite books, kept away from payment.test.js (days 3-28) and
 * booking.test.js (days 60+). Every suite orders rooms by id and posts right
 * after the lookup, so two suites sharing dates would race for the same room:
 * the second POST gets a 409 and the failure lands on whichever test happened
 * to be slower. Disjoint dates make that impossible. Windows stay far enough
 * out that the seeded near-term bookings never overlap them either.
 */
const WINDOW_STARTS = [31, 35, 39, 43, 47, 51];

/**
 * Ascending room order, the mirror image of the other suites' descending
 * order, so a shared date would still land on different rooms.
 */
async function findFreeRoom(checkIn, checkOut) {
    const rows = await select(
        `SELECT r.id, r.room_number FROM rooms r
         WHERE r.is_active = 1 AND r.status = 'available'
           AND NOT EXISTS (
               SELECT 1 FROM bookings b
               WHERE b.room_id = r.id
                 AND b.status IN ('pending', 'confirmed', 'checked_in')
                 AND b.check_in < :out AND b.check_out > :in
           )
         ORDER BY r.id ASC LIMIT 1`,
        { in: checkIn, out: checkOut },
    );
    return rows.length ? rows[0] : null;
}

/**
 * Creates a booking owned by the guest, ready to be paid.
 *
 * A 409 means another suite took the room between the lookup and the post,
 * so the next window is tried instead of failing a test that has not done
 * anything wrong. Only an unexpected status is a real error.
 */
async function createBookableBooking() {
    for (const start of WINDOW_STARTS) {
        const checkIn = dateOnly(start);
        const checkOut = dateOnly(start + 2);
        const room = await findFreeRoom(checkIn, checkOut);
        if (!room) continue;

        const created = await (await guest()).post('/api/bookings', {
            roomId: room.id,
            checkIn,
            checkOut,
            guests: 2,
            // The marker `cleanTestBookings` looks for. Without it these rows
            // are indistinguishable from real reservations and are never
            // reclaimed, so repeated runs slowly consume the inventory.
            specialRequests: RUN_MARKER,
        });

        if (created.status === 201) return created.body.data.booking;
        if (created.status !== 409) {
            assert.fail(`Booking creation failed: ${created.status} ${created.body?.message}`);
        }
    }

    assert.fail(
        'No free room in any of the test windows. The seeded inventory has been exhausted.',
    );
}
