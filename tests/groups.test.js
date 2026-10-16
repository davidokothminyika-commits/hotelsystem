/**
 * tests/groups.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for group (allotment) bookings: creating a block of
 * rooms, confirming it as one action, adding rooms later, and releasing it.
 *
 * RUN
 *   node --test tests/groups.test.js
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

/** Track group ids this run created, so cleanup can be exact. */
const createdGroups = [];

before(async () => {
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    await cleanup();
    await stopTestServer();
    await closePool();
});

/** Future dates, in YYYY-MM-DD, far from other suites' windows. */
function stayWindow(offsetDays = 240, nights = 2) {
    const pad = (value) => String(value).padStart(2, '0');
    const toIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const start = new Date();
    start.setDate(start.getDate() + offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + nights);
    return { checkIn: toIso(start), checkOut: toIso(end) };
}

/** Picks rooms that are free for the window, distinct, as specific as needed. */
async function availableRooms(count, { checkIn, checkOut }) {
    const client = new TestClient();
    const result = await client.get(
        `/api/rooms/availability?guests=1&checkIn=${checkIn}&checkOut=${checkOut}&limit=${count}`,
    );
    assert.equal(result.status, 200, 'availability search should succeed');
    assert.ok(result.body.data.length >= count, `need ${count} free rooms for the window`);
    return result.body.data.slice(0, count).map((room) => room.id);
}

async function cleanup() {
    // Children before parents: booking_guests and folio rows cascade from
    // bookings, but deleting in explicit order keeps foreign key errors out
    // of the teardown path however a test failed.
    for (const groupId of createdGroups) {
        await execute(
            `DELETE b FROM bookings b JOIN booking_groups g ON g.id = :id
             WHERE b.group_id = g.id AND b.special_requests LIKE :marker`,
            { id: groupId, marker: `${RUN_MARKER}%` },
        ).catch(() => {});
        await execute('DELETE FROM booking_groups WHERE id = :id', { id: groupId }).catch(() => {});
    }

    // Catch anything a failing test left attached to the marker.
    await execute(
        `DELETE b FROM bookings b
         WHERE b.special_requests LIKE :marker
           AND b.special_requests <> :keep`,
        { marker: `${'Automated test booking'}%`, keep: RUN_MARKER },
    ).catch(() => {});
    await resetRoomStatuses();
}

describe('Group (allotment) bookings', () => {
    test('a guest cannot create or even list groups', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');

        const list = await client.get('/api/booking-groups');
        assert.equal(list.status, 403, `guest listing groups must be forbidden, got ${list.status}`);

        const create = await client.post('/api/booking-groups', {
            name: 'Should not exist',
            ...stayWindow(),
            rooms: [{ roomId: 1 }],
        });
        assert.equal(create.status, 403);
        assert.equal(createdGroups.length, 0, 'nothing must have been created');
    });

    test('creates a block with one reservation per room', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');
        const [roomA, roomB] = await availableRooms(2, stayWindow());

        const response = await client.post('/api/booking-groups', {
            name: `Tour group ${RUN_MARKER}`,
            contactName: 'Amara Osei',
            contactEmail: 'amara@example.com',
            notes: RUN_MARKER,
            ...stayWindow(),
            rooms: [{ roomId: roomA, guests: 2 }, { roomId: roomB }],
        });

        assert.equal(response.status, 201, JSON.stringify(response.body));
        const group = response.body.data.group;
        createdGroups.push(group.id);

        assert.match(group.groupReference, /^GRP/);
        assert.equal(group.status, 'tentative');
        assert.equal(group.roomCount, 2, 'both rooms held');
        assert.ok(group.totalAmount > 0, 'money totals aggregate');

        const detail = await client.get(`/api/booking-groups/${group.id}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.group.bookings.length, 2);
        assert.ok(
            detail.body.data.group.bookings.every((booking) => booking.status === 'pending'),
            'members start pending',
        );
        assert.ok(
            detail.body.data.group.bookings.every((booking) => booking.bookingReference.startsWith('BK')),
            'members are ordinary reservations',
        );
    });

    test('rejects a block with the same room twice before writing anything', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');
        const [roomA] = await availableRooms(1, stayWindow());

        const response = await client.post('/api/booking-groups', {
            name: `Duplicate room ${RUN_MARKER}`,
            ...stayWindow(),
            rooms: [{ roomId: roomA }, { roomId: roomA }],
        });

        assert.equal(response.status, 400, 'validation rejects the duplicate input');
        assert.equal(response.body.code, 'DUPLICATE_ROOM');
        const afterCount = await select(
            'SELECT COUNT(*) AS total FROM booking_groups WHERE name = :name',
            { name: `Duplicate room ${RUN_MARKER}` },
        );
        assert.equal(Number(afterCount[0].total), 0, 'no group row was written');
    });

    test('rejects a block where a room is already taken', async () => {
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');
        const window = stayWindow(245);
        const [roomA] = await availableRooms(1, window);

        // Someone else takes the room for the window first.
        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const booking = await guest.post('/api/bookings', {
            roomId: roomA,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            guests: 1,
            specialRequests: RUN_MARKER,
        });
        assert.equal(booking.status, 201, 'the interfering booking must succeed');

        const group = await staff.post('/api/booking-groups', {
            name: `Conflict group ${RUN_MARKER}`,
            notes: RUN_MARKER,
            ...window,
            rooms: [{ roomId: roomA }],
        });

        assert.equal(group.status, 409, `conflict yields 409, got ${group.status}: ${JSON.stringify(group.body)}`);
        assert.equal(group.body.code, 'ROOM_UNAVAILABLE');
    });

    test('confirms every member reservation at once', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');
        const [roomA, roomB] = await availableRooms(2, stayWindow(250));

        const created = await client.post('/api/booking-groups', {
            name: `Conference ${RUN_MARKER}`,
            notes: RUN_MARKER,
            ...stayWindow(250),
            rooms: [{ roomId: roomA }, { roomId: roomB }],
        });
        assert.equal(created.status, 201);
        const group = created.body.data.group;
        createdGroups.push(group.id);

        const confirmed = await client.post(`/api/booking-groups/${group.id}/confirm`, {});
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        const after = confirmed.body.data.group;

        assert.equal(after.status, 'confirmed');
        assert.ok(after.confirmedAt, 'confirmation timestamp recorded');
        assert.ok(
            after.bookings.every((booking) => booking.status === 'confirmed'),
            'every member reservation is confirmed',
        );

        // Confirming twice is a user error, not a state change.
        const again = await client.post(`/api/booking-groups/${group.id}/confirm`, {});
        assert.equal(again.status, 400);
        assert.equal(again.body.code, 'ALREADY_CONFIRMED');
    });

    test('adds rooms to an existing block', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');
        const window = stayWindow(255);
        const [roomA, roomB] = await availableRooms(2, window);

        const created = await client.post('/api/booking-groups', {
            name: `Wedding ${RUN_MARKER}`,
            notes: RUN_MARKER,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            rooms: [{ roomId: roomA }],
        });
        assert.equal(created.status, 201);
        const group = created.body.data.group;
        createdGroups.push(group.id);

        // An added room joins the block's dates; it does not bring its own.
        const added = await client.post(`/api/booking-groups/${group.id}/rooms`, {
            rooms: [{ roomId: roomB }],
        });
        assert.equal(added.status, 200, JSON.stringify(added.body));
        assert.equal(added.body.data.group.roomCount, 2);

        const detail = await client.get(`/api/booking-groups/${group.id}`);
        const member = detail.body.data.group.bookings.find((b) => Number(b.roomId) === roomB);
        assert.ok(member, 'the added room is a member reservation');
        assert.equal(member.checkIn, window.checkIn, 'block dates win');

        const retried = await client.post(`/api/booking-groups/${group.id}/rooms`, {
            rooms: [{ roomId: roomB }],
        });
        assert.equal(retried.status, 400, 'a room already in the block is rejected');
        assert.equal(retried.body.code, 'ROOM_ALREADY_IN_GROUP');
    });

    test('cancelling releases every room in the block', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');
        const window = stayWindow(260);
        const [roomA] = await availableRooms(1, window);

        const created = await client.post('/api/booking-groups', {
            name: `Released ${RUN_MARKER}`,
            notes: RUN_MARKER,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            rooms: [{ roomId: roomA }],
        });
        assert.equal(created.status, 201);
        const group = created.body.data.group;
        createdGroups.push(group.id);

        const cancelled = await client.post(`/api/booking-groups/${group.id}/cancel`, {
            reason: 'Party did not fill the block',
        });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        const after = cancelled.body.data.group;

        assert.equal(after.status, 'cancelled');
        assert.ok(after.cancelledAt);
        assert.ok(
            after.bookings.every((booking) => booking.status === 'cancelled'),
            'every member reservation is cancelled',
        );

        // The cancel endpoint is idempotent in verdict, not in effect: asking
        // again is refused rather than re-stamping.
        const again = await client.post(`/api/booking-groups/${group.id}/cancel`, {});
        assert.equal(again.status, 400);

        // The room is genuinely back on sale for those dates.
        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const rebook = await guest.post('/api/bookings', {
            roomId: roomA,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            guests: 1,
            specialRequests: RUN_MARKER,
        });
        assert.equal(rebook.status, 201, 'a released room can be sold again');
    });

    test('lists groups with filters', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');

        const list = await client.get('/api/booking-groups?status=confirmed&limit=5');
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body.data));
        assert.ok(list.body.data.every((group) => group.status === 'confirmed'));
    });
});
