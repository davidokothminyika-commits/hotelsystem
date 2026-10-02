/**
 * tests/booking.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for room search, availability and the booking lifecycle.
 *
 * WHY IT EXISTS
 * Double booking is the single most damaging defect a hotel system can have:
 * two guests arrive expecting the same room. The concurrency test below fires
 * simultaneous requests at the same room and asserts that exactly one wins. A
 * sequential test would pass even with broken locking, which is why the
 * concurrent case is the one that matters.
 *
 * RUN
 *   npm test
 *
 * Requires: npm run seed
 */
import test, { before, after, beforeEach, describe } from 'node:test';
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
} from './helpers/test-server.js';

before(async () => {
    // Booking tests consume rooms for future dates. Clearing rows left by an
    // earlier run keeps the suite repeatable instead of slowly exhausting the
    // inventory, and restores any rooms left mid-cleaning by a failed run.
    await cleanTestBookings();
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    await stopTestServer();
    await closePool();
});

/**
 * Books a room for a future window and returns the API response.
 * Uses absolute dates far enough ahead that seeded bookings do not interfere.
 */
async function bookRoom(client, { roomId, checkIn, checkOut, guests = 2 }) {
    return client.post('/api/bookings', {
        roomId,
        checkIn,
        checkOut,
        guests,
        specialRequests: 'Automated test booking',
    });
}

/**
 * Finds a room that is free for the given window, then books it.
 * Combines the room lookup and the booking so tests cannot drift apart when
 * the room selection logic changes.
 */
async function bookFreeRoom(client, { checkIn, checkOut, guests = 2 }) {
    const roomId = await pickAvailableRoom(guests, checkIn, checkOut);
    const result = await bookRoom(client, { roomId, checkIn, checkOut, guests });
    return { ...result, roomId };
}

/** A date offset from today, in YYYY-MM-DD. */
function futureDate(offsetDays) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
}

/**
 * Picks a room id that is genuinely free for the requested window.
 *
 * The check is date aware on purpose. Picking "the first available room"
 * without dates returns a room that may already be booked for the dates a
 * later assertion needs, which makes the suite order dependent and fails on
 * the second run against a database that still holds the first run's data.
 */
async function pickAvailableRoom(guests = 2, checkIn, checkOut) {
    const client = new TestClient();

    // With no dates given, search broadly so a room that is free in practice
    // is still found even if it is booked for some other window.
    const query =
        checkIn && checkOut
            ? `/api/rooms/availability?guests=${guests}&checkIn=${checkIn}&checkOut=${checkOut}&limit=1`
            : `/api/rooms/availability?guests=${guests}&limit=1`;

    const response = await client.get(query);
    assert.equal(response.status, 200, 'availability search should succeed');
    assert.ok(
        response.body.data.length > 0,
        `seeded data should provide available rooms${checkIn ? ` for ${checkIn} to ${checkOut}` : ''}`,
    );
    return response.body.data[0].id;
}

// ---------------------------------------------------------------------------
describe('Room search and availability', () => {
    test('returns available rooms for the seeded inventory', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/rooms/availability?guests=2&limit=5');

        assert.equal(status, 200);
        assert.equal(body.success, true);
        assert.ok(Array.isArray(body.data));
        assert.ok(body.data.length > 0);
        assert.ok(body.meta.total > 0);
    });

    test('every returned room has the fields the UI renders', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/rooms/availability?limit=3');

        for (const room of body.data) {
            assert.ok(room.id, 'room must have an id');
            assert.ok(room.roomNumber, 'room must have a number');
            assert.ok(room.pricePerNight > 0, 'room must have a nightly price');
            assert.ok(room.roomType?.name, 'room must have a type name');
            assert.ok(Array.isArray(room.amenities), 'amenities must be an array');
        }
    });

    test('filters by guest count, excluding rooms that are too small', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/rooms/availability?guests=5&limit=50');

        assert.ok(body.data.length > 0, 'a five guest search should match some rooms');
        for (const room of body.data) {
            assert.ok(
                room.capacity >= 5,
                `room ${room.roomNumber} has capacity ${room.capacity} and must not match a 5 guest search`,
            );
        }
    });

    test('filters by price range', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/rooms/availability?minPrice=200&maxPrice=300&limit=50');

        assert.ok(body.data.length > 0, 'the seeded inventory should include rooms in this band');
        for (const room of body.data) {
            assert.ok(room.pricePerNight >= 200 && room.pricePerNight <= 300);
        }
    });

    test('sorts by price ascending and descending', async () => {
        const client = new TestClient();

        const ascending = await client.get('/api/rooms/availability?sortBy=r.price_per_night&sortDir=asc&limit=10');
        const descending = await client.get('/api/rooms/availability?sortBy=r.price_per_night&sortDir=desc&limit=10');

        const ascPrices = ascending.body.data.map((room) => room.pricePerNight);
        const descPrices = descending.body.data.map((room) => room.pricePerNight);

        assert.deepEqual(ascPrices, [...ascPrices].sort((a, b) => a - b));
        assert.deepEqual(descPrices, [...descPrices].sort((a, b) => b - a));
    });

    test('calculates the stay total for the requested dates', async () => {
        const client = new TestClient();
        const { body } = await client.get(
            `/api/rooms/availability?checkIn=${futureDate(60)}&checkOut=${futureDate(63)}&guests=2&limit=3`,
        );

        assert.equal(body.data.length, 3);
        assert.equal(body.meta.total >= 3, true);
        for (const room of body.data) {
            // 3 nights plus 16% tax and 10% service charge.
            const subtotal = room.pricePerNight * 3;
            const expected = Number((subtotal * 1.26).toFixed(2));
            assert.ok(
                Math.abs(room.stayTotal - expected) < 0.02,
                `expected about ${expected} for ${room.pricePerNight} x 3 nights, received ${room.stayTotal}`,
            );
        }
    });

    test('rejects an invalid date format', async () => {
        const client = new TestClient();
        const { status } = await client.get('/api/rooms/availability?checkIn=15-06-2026&checkOut=2026-06-18');
        assert.equal(status, 422);
    });

    test('rejects a checkout date that is not after checkin', async () => {
        const client = new TestClient();
        const { status, body } = await client.get(
            `/api/rooms/availability?checkIn=${futureDate(60)}&checkOut=${futureDate(60)}`,
        );
        assert.equal(status, 400);
        assert.equal(body.code, 'INVALID_DATE_RANGE');
    });

    test('rejects a checkin date in the past', async () => {
        const client = new TestClient();
        const { status, body } = await client.get(
            `/api/rooms/availability?checkIn=${futureDate(-5)}&checkOut=${futureDate(5)}`,
        );
        assert.equal(status, 400);
        assert.equal(body.code, 'DATE_IN_PAST');
    });

    test('exposes room types and amenities', async () => {
        const client = new TestClient();

        const types = await client.get('/api/rooms/types');
        assert.equal(types.status, 200);
        assert.ok(types.body.data.roomTypes.length >= 5);

        const amenities = await client.get('/api/rooms/amenities');
        assert.equal(amenities.status, 200);
        assert.ok(amenities.body.data.amenities.length > 0);
    });

    test('returns 404 for a room that does not exist', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/rooms/999999');
        assert.equal(status, 404);
        assert.equal(body.code, 'ROOM_NOT_FOUND');
    });
});

// ---------------------------------------------------------------------------
describe('Booking creation', () => {
    let guest;

    beforeEach(async () => {
        guest = await loginAs('guest@example.com', 'Guest@1234');
    });

    test('creates a pending booking with a calculated total', async () => {
        const checkIn = futureDate(70);
        const checkOut = futureDate(72);
        const roomId = await pickAvailableRoom(2, checkIn, checkOut);

        const { status, body } = await bookRoom(guest.client, { roomId, checkIn, checkOut });

        assert.equal(status, 201);
        assert.equal(body.success, true);
        assert.equal(body.data.booking.status, 'pending');
        assert.equal(body.data.booking.checkIn, checkIn);
        assert.equal(body.data.booking.checkOut, checkOut);
        assert.equal(body.data.booking.nights, 2);
        assert.match(body.data.booking.bookingReference, /^BK/);
        assert.ok(body.data.booking.totalAmount > 0);
    });

    test('writes the booking to the database with a matching reference', async () => {
        const checkIn = futureDate(80);
        const checkOut = futureDate(82);
        const roomId = await pickAvailableRoom(2, checkIn, checkOut);

        const { body } = await bookRoom(guest.client, { roomId, checkIn, checkOut });

        const rows = await select('SELECT * FROM bookings WHERE booking_reference = :ref', {
            ref: body.data.booking.bookingReference,
        });

        assert.equal(rows.length, 1, 'the booking must be persisted');
        assert.equal(rows[0].room_id, roomId);
        assert.equal(rows[0].nights, 2);
        assert.equal(Number(rows[0].total_amount), body.data.booking.totalAmount);
    });

    test('rejects a booking for a room that does not exist', async () => {
        const { status, body } = await bookRoom(guest.client, {
            roomId: 999999,
            checkIn: futureDate(90),
            checkOut: futureDate(92),
        });

        assert.equal(status, 404);
        assert.equal(body.code, 'ROOM_NOT_FOUND');
    });

    test('rejects more guests than the room can hold', async () => {
        const roomId = await pickAvailableRoom(2);
        const { status, body } = await bookRoom(guest.client, {
            roomId,
            checkIn: futureDate(95),
            checkOut: futureDate(97),
            guests: 20,
        });

        assert.equal(status, 400);
        assert.ok(['CAPACITY_EXCEEDED', 'VALIDATION_ERROR'].includes(body.code));
    });

    test('rejects a stay longer than the maximum permitted', async () => {
        const roomId = await pickAvailableRoom(2);
        const { status, body } = await bookRoom(guest.client, {
            roomId,
            checkIn: futureDate(100),
            checkOut: futureDate(200), // 100 nights, limit is 30
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'STAY_TOO_LONG');
    });

    test('rejects a checkin date in the past', async () => {
        const roomId = await pickAvailableRoom(2);
        const { status, body } = await bookRoom(guest.client, {
            roomId,
            checkIn: futureDate(-3),
            checkOut: futureDate(5),
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'DATE_IN_PAST');
    });

    test('requires authentication', async () => {
        const client = new TestClient();
        const roomId = await pickAvailableRoom(2);
        const { status, body } = await bookRoom(client, {
            roomId,
            checkIn: futureDate(110),
            checkOut: futureDate(112),
        });

        assert.equal(status, 401);
        assert.equal(body.code, 'NO_TOKEN');
    });
});

// ---------------------------------------------------------------------------
describe('Double booking prevention', () => {
    test('rejects a second booking for overlapping dates', async () => {
        const checkIn = futureDate(120);
        const checkOut = futureDate(123);
        const roomId = await pickAvailableRoom(2, checkIn, checkOut);

        const first = await loginAs('sarah@example.com', 'Guest@1234');
        const second = await loginAs('david@example.com', 'Guest@1234');

        const firstResult = await bookRoom(first.client, { roomId, checkIn, checkOut });
        assert.equal(firstResult.status, 201, 'the first booking should succeed');

        const secondResult = await bookRoom(second.client, { roomId, checkIn, checkOut });
        assert.equal(secondResult.status, 409, 'the overlapping booking must be rejected');
        assert.equal(secondResult.body.code, 'ROOM_UNAVAILABLE');
    });

    test('allows back-to-back stays: checkout day equals the next checkin day', async () => {
        // Choose the room against the FIRST window, then confirm the second
        // handover window is also free before asserting on it.
        const roomId = await pickAvailableRoom(2, futureDate(130), futureDate(132));
        const firstGuest = await loginAs('sarah@example.com', 'Guest@1234');
        const secondGuest = await loginAs('david@example.com', 'Guest@1234');

        // Stay one occupies nights of the 130th and 131st.
        const first = await bookRoom(firstGuest.client, {
            roomId,
            checkIn: futureDate(130),
            checkOut: futureDate(132),
        });
        assert.equal(first.status, 201);

        // Stay two arrives on the checkout day. The room is free that night,
        // so this is a valid handover, not a conflict.
        const second = await bookRoom(secondGuest.client, {
            roomId,
            checkIn: futureDate(132),
            checkOut: futureDate(134),
        });

        assert.equal(second.status, 201, 'back-to-back bookings must be allowed');
    });

    test('allows a partially overlapping stay only when it does not truly overlap', async () => {
        const roomId = await pickAvailableRoom(2, futureDate(140), futureDate(145));
        const guestA = await loginAs('sarah@example.com', 'Guest@1234');
        const guestB = await loginAs('david@example.com', 'Guest@1234');

        const first = await bookRoom(guestA.client, {
            roomId,
            checkIn: futureDate(140),
            checkOut: futureDate(145),
        });
        assert.equal(first.status, 201);

        // Starts one day before the first stay ends, so it overlaps.
        const overlap = await bookRoom(guestB.client, {
            roomId,
            checkIn: futureDate(144),
            checkOut: futureDate(147),
        });
        assert.equal(overlap.status, 409);
    });

    test('releases the room once a booking is cancelled', async () => {
        const checkIn = futureDate(150);
        const checkOut = futureDate(152);
        const roomId = await pickAvailableRoom(2, checkIn, checkOut);

        const first = await loginAs('sarah@example.com', 'Guest@1234');
        const created = await bookRoom(first.client, { roomId, checkIn, checkOut });
        assert.equal(created.status, 201);

        const bookingId = created.body.data.booking.id;

        const cancel = await first.client.post(`/api/bookings/${bookingId}/cancel`, {
            reason: 'Automated test cancellation',
        });
        assert.equal(cancel.status, 200);
        assert.equal(cancel.body.data.booking.status, 'cancelled');

        // A different guest can now take the same room and dates.
        const second = await loginAs('david@example.com', 'Guest@1234');
        const rebooked = await bookRoom(second.client, { roomId, checkIn, checkOut });

        assert.equal(rebooked.status, 201, 'a cancelled booking must free the room');
    });

    /**
     * THE CONCURRENCY TEST
     *
     * Ten requests are fired simultaneously for one room and one date range.
     * Exactly one must be created.
     *
     * This is the only test that actually proves the row lock works. Without
     * `SELECT ... FOR UPDATE`, every request would pass the availability
     * pre-check before any of them inserted, and several bookings would be
     * created for the same room.
     */
    test('only one of ten simultaneous requests wins the same room', async () => {
        const checkIn = futureDate(160);
        const checkOut = futureDate(162);
        const roomId = await pickAvailableRoom(2, checkIn, checkOut);

        const clients = await Promise.all([
            loginAs('sarah@example.com', 'Guest@1234'),
            loginAs('david@example.com', 'Guest@1234'),
            loginAs('guest@example.com', 'Guest@1234'),
        ]);

        // Fire all requests together and collect the outcomes.
        const attempts = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                bookRoom(clients[index % clients.length].client, { roomId, checkIn, checkOut }),
            ),
        );

        const created = attempts.filter((result) => result.status === 201);
        const rejected = attempts.filter((result) => result.status === 409);

        assert.equal(created.length, 1, `exactly one booking must succeed, received ${created.length}`);
        assert.equal(rejected.length, 9, `the other nine must be rejected with 409, received ${rejected.length}`);

        // Confirm directly in the database rather than trusting the responses.
        const rows = await select(
            `SELECT id FROM bookings
             WHERE room_id = :roomId
               AND status IN ('pending', 'confirmed', 'checked_in')
               AND check_in < :checkOut
               AND check_out > :checkIn`,
            { roomId, checkIn, checkOut },
        );

        assert.equal(rows.length, 1, `the database must contain exactly one booking, found ${rows.length}`);
    });
});

// ---------------------------------------------------------------------------
describe('Booking lifecycle', () => {
    let guest;
    let receptionist;

    beforeEach(async () => {
        guest = await loginAs('guest@example.com', 'Guest@1234');
        receptionist = await loginAs('reception@example.com', 'Reception@1234');
    });

    /**
     * Creates a booking for a window that is uniquely used by each test.
     * The room is chosen for those exact dates so a previous test's booking
     * can never block this one.
     */
    async function createBooking(offset = 170) {
        const checkIn = futureDate(offset);
        const checkOut = futureDate(offset + 2);
        const result = await bookFreeRoom(guest.client, { checkIn, checkOut });
        assert.equal(result.status, 201, `creating a booking for ${checkIn} failed`);
        return result.body.data.booking;
    }

    test('staff confirm a pending booking', async () => {
        const booking = await createBooking(172);
        assert.equal(booking.status, 'pending');

        const { status, body } = await receptionist.client.post(`/api/bookings/${booking.id}/confirm`, {});

        assert.equal(status, 200);
        assert.equal(body.data.booking.status, 'confirmed');
    });

    test('a confirmed booking can be checked in, and the room becomes occupied', async () => {
        const booking = await createBooking(174);
        await receptionist.client.post(`/api/bookings/${booking.id}/confirm`, {});

        const { status, body } = await receptionist.client.post(`/api/bookings/${booking.id}/check-in`, {});

        assert.equal(status, 200);
        assert.equal(body.data.booking.status, 'checked_in');

        const room = await receptionist.client.get(`/api/rooms/${booking.roomId}`);
        assert.equal(room.body.data.room.status, 'occupied');
    });

    test('checkout marks the booking complete and the room for cleaning', async () => {
        const booking = await createBooking(176);
        await receptionist.client.post(`/api/bookings/${booking.id}/confirm`, {});
        await receptionist.client.post(`/api/bookings/${booking.id}/check-in`, {});

        const { status, body } = await receptionist.client.post(`/api/bookings/${booking.id}/check-out`, {});

        assert.equal(status, 200);
        assert.equal(body.data.booking.status, 'checked_out');

        // Housekeeping must inspect the room before it is sold again.
        const room = await receptionist.client.get(`/api/rooms/${booking.roomId}`);
        assert.equal(room.body.data.room.status, 'cleaning');
    });

    test('a guest cannot confirm their own booking', async () => {
        const booking = await createBooking(178);
        const { status, body } = await guest.client.post(`/api/bookings/${booking.id}/confirm`, {});

        assert.equal(status, 403);
        assert.equal(body.code, 'INSUFFICIENT_ROLE');
    });

    test('a guest cannot check in', async () => {
        const booking = await createBooking(180);
        await receptionist.client.post(`/api/bookings/${booking.id}/confirm`, {});

        const { status } = await guest.client.post(`/api/bookings/${booking.id}/check-in`, {});
        assert.equal(status, 403);
    });

    test('an invalid status transition is rejected', async () => {
        const booking = await createBooking(182);

        // Checking out a pending booking is not a valid transition.
        const { status, body } = await receptionist.client.post(`/api/bookings/${booking.id}/check-out`, {});

        assert.equal(status, 400);
        assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
    });

    test('a guest cannot view another guest booking', async () => {
        const booking = await createBooking(184);
        const other = await loginAs('david@example.com', 'Guest@1234');

        const { status, body } = await other.client.get(`/api/bookings/${booking.id}`);

        // 404 rather than 403, so the endpoint does not confirm it exists.
        assert.equal(status, 404);
        assert.equal(body.code, 'BOOKING_NOT_FOUND');
    });

    test('a guest can view and cancel their own booking', async () => {
        const booking = await createBooking(186);

        const view = await guest.client.get(`/api/bookings/${booking.id}`);
        assert.equal(view.status, 200);

        const cancel = await guest.client.post(`/api/bookings/${booking.id}/cancel`, {
            reason: 'Plans changed',
        });
        assert.equal(cancel.status, 200);
        assert.equal(cancel.body.data.booking.status, 'cancelled');
        assert.equal(cancel.body.data.booking.cancellationReason, 'Plans changed');
    });

    test('cancelling twice is rejected', async () => {
        const booking = await createBooking(188);
        await guest.client.post(`/api/bookings/${booking.id}/cancel`, { reason: 'First' });

        const second = await guest.client.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Second' });
        assert.equal(second.status, 400);
        assert.equal(second.body.code, 'ALREADY_CANCELLED');
    });

    test('a checked-in booking cannot be cancelled', async () => {
        const booking = await createBooking(190);
        await receptionist.client.post(`/api/bookings/${booking.id}/confirm`, {});
        await receptionist.client.post(`/api/bookings/${booking.id}/check-in`, {});

        const { status, body } = await receptionist.client.post(`/api/bookings/${booking.id}/cancel`, {});

        assert.equal(status, 400);
        assert.equal(body.code, 'CANNOT_CANCEL_CHECKED_IN');
    });

    test('the guest summary reflects the bookings created', async () => {
        const before = await guest.client.get('/api/bookings/summary');
        assert.equal(before.status, 200);
        assert.ok(before.body.data.summary.totalBookings >= 0);

        await createBooking(192);

        const after = await guest.client.get('/api/bookings/summary');
        assert.equal(after.body.data.summary.totalBookings, before.body.data.summary.totalBookings + 1);
    });

    test('guests only ever see their own bookings in the list', async () => {
        const sarah = await loginAs('sarah@example.com', 'Guest@1234');
        await bookFreeRoom(sarah.client, {
            checkIn: futureDate(194),
            checkOut: futureDate(196),
        });

        const guestList = await guest.client.get('/api/bookings?limit=100');
        const sarahList = await sarah.client.get('/api/bookings?limit=100');

        const guestIds = new Set(guestList.body.data.map((booking) => booking.id));
        const sarahIds = sarahList.body.data.map((booking) => booking.id);

        for (const id of sarahIds) {
            assert.ok(!guestIds.has(id), 'a guest must not see another guest booking in their list');
        }
    });

    test('reception sees all bookings, not just their own', async () => {
        const sarah = await loginAs('sarah@example.com', 'Guest@1234');
        await bookFreeRoom(sarah.client, {
            checkIn: futureDate(198),
            checkOut: futureDate(200),
        });

        const staffList = await receptionist.client.get('/api/bookings?limit=100');
        assert.ok(staffList.body.data.length > 1, 'staff should see bookings from multiple guests');
    });
});