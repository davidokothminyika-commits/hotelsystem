/**
 * tests/folio.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the guest folio: posting charges and credits, the
 * recomputed bill, voiding, and who may do what.
 *
 * THE BUILDING BLOCK
 * Every test posts to a fresh booking and asserts against the booking's
 * stored totals, because that is the invariant the feature exists to keep:
 * the ledger is the truth and the bill follows it.
 *
 * RUN
 *   node --test tests/folio.test.js
 *
 * Requires: npm run seed
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    startTestServer,
    stopTestServer,
    TestClient,
    loginAs,
    select,
    execute,
    closePool,
    cleanTestBookings,
    resetRoomStatuses,
    testBookingMarker,
} from './helpers/test-server.js';

const RUN_MARKER = testBookingMarker();

/** Bookings created by this run, so cleanup releases exactly what it took. */
const createdBookingIds = [];

before(async () => {
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    // folio_entries and payments both cascade from bookings, so removing the
    // bookings removes the ledger history this run wrote.
    for (const id of createdBookingIds) {
        await execute('DELETE FROM bookings WHERE id = :id', { id }).catch(() => {});
    }
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await stopTestServer();
    await closePool();
});

function stayWindow(offsetDays = 300, nights = 2) {
    const pad = (value) => String(value).padStart(2, '0');
    const toIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const start = new Date();
    start.setDate(start.getDate() + offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + nights);
    return { checkIn: toIso(start), checkOut: toIso(end) };
}

/**
 * A booking owned by the demo guest for the folio to act on.
 * Returns both the booking and the guest's client, because a folio is read
 * by its owner as well as by the desk.
 */
async function makeBooking() {
    const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
    const availability = await guest.get(
        `/api/rooms/availability?guests=1&checkIn=${stayWindow().checkIn}&checkOut=${stayWindow().checkOut}&limit=1`,
    );
    assert.equal(availability.status, 200, 'availability must succeed');
    assert.ok(availability.body.data.length > 0, 'seeded data has free rooms');
    const roomId = availability.body.data[0].id;

    const response = await guest.post('/api/bookings', {
        roomId,
        ...stayWindow(),
        guests: 1,
        specialRequests: RUN_MARKER,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    createdBookingIds.push(response.body.data.booking.id);
    return {
        guest,
        booking: response.body.data.booking,
        baseSubtotal: response.body.data.booking.subtotal,
    };
}

describe('Guest folio', () => {
    test('a fresh folio shows the room rate and nothing else', async () => {
        const { booking, baseSubtotal } = await makeBooking();
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');

        const response = await staff.get(`/api/folios/${booking.id}`);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const folio = response.body.data.folio;

        assert.equal(folio.booking.bookingReference, booking.bookingReference);
        assert.deepEqual(folio.entries, [], 'no ledger rows yet');
        assert.equal(folio.roomRate, baseSubtotal);
        assert.equal(folio.extrasTotal, 0);
        assert.equal(folio.totals.subtotal, baseSubtotal);
        assert.ok(folio.totals.balanceDue > 0, 'nothing is paid yet');
    });

    test('the guest reads their own folio but cannot post to it', async () => {
        const { guest, booking } = await makeBooking();

        const read = await guest.get(`/api/folios/${booking.id}`);
        assert.equal(read.status, 200, 'an owner can read their own bill');

        const post = await guest.post(`/api/folios/${booking.id}/entries`, {
            entryType: 'charge',
            description: 'Guest-written charge',
            amount: 1,
        });
        assert.equal(post.status, 403, 'posting is a folio:write decision');
    });

    test('a posted charge raises the bill with tax and service', async () => {
        const { booking, baseSubtotal } = await makeBooking();
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');

        const before = await staff.get(`/api/folios/${booking.id}`);
        const beforeTotal = before.body.data.folio.totals.totalAmount;

        const response = await staff.post(`/api/folios/${booking.id}/entries`, {
            entryType: 'charge',
            description: 'Minibar',
            amount: 20,
        });

        assert.equal(response.status, 201, JSON.stringify(response.body));
        const folio = response.body.data;
        assert.equal(folio.entry.entryType, 'charge');
        assert.equal(folio.entry.amount, 20);
        assert.ok(folio.entry.createdByName, 'the post records who did it');

        const breakdown = folio.breakdown;
        assert.equal(breakdown.subtotal, Number((baseSubtotal + 20).toFixed(2)), 'base + 20');
        assert.equal(
            breakdown.taxAmount,
            Number(((baseSubtotal + 20) * 0.16).toFixed(2)),
            '16% VAT on the adjusted subtotal',
        );
        assert.equal(
            breakdown.serviceCharge,
            Number(((baseSubtotal + 20) * 0.1).toFixed(2)),
            '10% service on the adjusted subtotal',
        );
        assert.ok(breakdown.totalAmount > beforeTotal, 'the stored bill rose');

        // The booking row itself is the source the payment flow reads.
        const bookingRows = await select(
            'SELECT total_amount, subtotal FROM bookings WHERE id = :id',
            { id: booking.id },
        );
        assert.equal(Number(bookingRows[0].total_amount), breakdown.totalAmount);
    });

    test('a credit lowers the bill the same way', async () => {
        const { booking, baseSubtotal } = await makeBooking();
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');

        const response = await staff.post(`/api/folios/${booking.id}/entries`, {
            entryType: 'credit',
            description: 'Goodwill discount',
            amount: 5,
        });

        assert.equal(response.status, 201);
        assert.equal(response.body.data.breakdown.subtotal, Number((baseSubtotal - 5).toFixed(2)));
    });

    test('voiding an entry returns the bill to its earlier shape', async () => {
        const { booking, baseSubtotal } = await makeBooking();
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');

        const posted = await staff.post(`/api/folios/${booking.id}/entries`, {
            entryType: 'charge',
            description: 'Laundry mix-up',
            amount: 12.5,
        });
        assert.equal(posted.status, 201);
        const entryId = posted.body.data.entry.id;

        const voided = await staff.post(
            `/api/folios/${booking.id}/entries/${entryId}/void`,
            { reason: 'Posted against the wrong room' },
        );
        assert.equal(voided.status, 200, JSON.stringify(voided.body));

        const entry = voided.body.data.entry;
        assert.ok(entry.voidedAt, 'the row is stamped, not deleted');
        assert.equal(entry.voidReason, 'Posted against the wrong room');

        const breakdown = voided.body.data.breakdown;
        assert.equal(breakdown.subtotal, baseSubtotal, 'voided rows stop counting');

        // The ledger still shows what happened, with the void visible.
        const folio = await staff.get(`/api/folios/${booking.id}`);
        const ledger = folio.body.data.folio.entries;
        assert.equal(ledger.length, 1, 'history kept');
        assert.ok(ledger[0].voidedAt, 'the history row shows the void');

        const voidAgain = await staff.post(`/api/folios/${booking.id}/entries/${entryId}/void`, {});
        assert.equal(voidAgain.status, 400, 'double voiding is refused');
    });

    test('money rules: zero, negative and enormous amounts are refused', async () => {
        const { booking } = await makeBooking();
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');

        for (const amount of [0, -5, 1_000_000]) {
            const response = await staff.post(`/api/folios/${booking.id}/entries`, {
                entryType: 'charge',
                description: 'Bad amount',
                amount,
            });
            assert.ok([400, 422].includes(response.status), `amount ${amount} must be refused`);
        }

        const unknownType = await staff.post(`/api/folios/${booking.id}/entries`, {
            entryType: 'discount',
            description: 'Not a type',
            amount: 5,
        });
        assert.equal(unknownType.status, 422, 'unknown entry types are refused');
    });

    test('restaurant staff and housekeeping cannot touch folios', async () => {
        const { booking } = await makeBooking();

        const { client: restaurant } = await loginAs('restaurant@example.com', 'Restaurant@1234');
        assert.equal((await restaurant.get(`/api/folios/${booking.id}`)).status, 200,
            'staff may see the board-level folio of a booking');
        assert.equal(
            (await restaurant.get('/api/folios')).status,
            403,
            'the folio board needs folio:read',
        );

        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');
        assert.equal((await housekeeping.get('/api/folios')).status, 403);

        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');
        assert.equal((await staff.get('/api/folios')).status, 200, 'reception works the board');
    });

    test('a stranger cannot read someone else\'s folio', async () => {
        const { booking } = await makeBooking();

        const { client: otherGuest } = await loginAs('david@example.com', 'Guest@1234');
        const response = await otherGuest.get(`/api/folios/${booking.id}`);
        assert.equal(response.status, 404, 'a stranger gets a 404, not a 403');
    });
});
