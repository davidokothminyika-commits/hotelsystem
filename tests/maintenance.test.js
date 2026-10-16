/**
 * tests/maintenance.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the repair work orders: raising a ticket, the
 * automatic room status changes that come with it, resolving, and who may do
 * what.
 *
 * RUN
 *   node --test tests/maintenance.test.js
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
    resetRoomStatuses,
} from './helpers/test-server.js';

const createdTicketIds = [];
const touchedRoomIds = [];

before(async () => {
    await startTestServer();
});

after(async () => {
    for (const id of createdTicketIds) {
        await execute('DELETE FROM maintenance_tickets WHERE id = :id', { id }).catch(() => {});
    }
    // A room whose ticket opened mid-run must not keep a test run's status.
    await resetRoomStatuses();
    await stopTestServer();
    await closePool();
});

/** An available room id to attach a ticket to. */
async function availableRoom() {
    const client = new TestClient();
    const result = await client.get('/api/rooms/availability?guests=1&limit=1');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.length > 0, 'seeded data has rooms');
    return result.body.data[0];
}

describe('Maintenance work orders', () => {
    test('guests are refused everywhere on this surface', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');

        assert.equal((await client.get('/api/maintenance')).status, 403);
        const created = await client.post('/api/maintenance', {
            title: 'Guest-raised ticket',
        });
        assert.equal(created.status, 403);
    });

    test('raising a ticket takes the room out of the sellable pool', async () => {
        const room = await availableRoom();
        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');

        const response = await housekeeping.post('/api/maintenance', {
            roomId: room.id,
            title: 'Leaking tap under the sink',
            description: 'Guest in 12 reported water pooling overnight',
            priority: 'high',
        });

        assert.equal(response.status, 201, JSON.stringify(response.body));
        const ticket = response.body.data.ticket;
        createdTicketIds.push(ticket.id);
        touchedRoomIds.push(room.id);

        assert.match(ticket.ticketNumber, /^MT/);
        assert.equal(ticket.status, 'open');
        assert.equal(ticket.priority, 'high');
        assert.ok(ticket.reportedByName, 'the reporter is recorded');

        const roomRows = await select('SELECT status FROM rooms WHERE id = :id', { id: room.id });
        assert.equal(roomRows[0].status, 'maintenance', 'the room cannot be sold while broken');

        // And the availability search indeed refuses it for the same window.
        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const pad = (value) => String(value).padStart(2, '0');
        const day = new Date();
        day.setDate(day.getDate() + 320);
        const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
        const search = await guest.get(
            `/api/rooms/availability?guests=1&checkIn=${iso}&checkOut=${iso.slice(0, 8)}30&limit=100`,
        );
        assert.equal(search.status, 200);
        assert.ok(
            !search.body.data.some((candidate) => candidate.id === room.id),
            'a room under repair leaves the availability pool',
        );
    });

    test('a ticket without a room is valid (public areas)', async () => {
        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');

        const response = await housekeeping.post('/api/maintenance', {
            title: 'Lamp flickering in the lobby',
            priority: 'low',
        });

        assert.equal(response.status, 201);
        assert.equal(response.body.data.ticket.roomId, null);
        createdTicketIds.push(response.body.data.ticket.id);
    });

    test('resolving hands the room to housekeeping, not straight to sale', async () => {
        const room = await availableRoom();
        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');

        const created = await housekeeping.post('/api/maintenance', {
            roomId: room.id,
            title: 'Bathroom fan noisy',
            priority: 'normal',
        });
        assert.equal(created.status, 201);
        const ticket = created.body.data.ticket;
        createdTicketIds.push(ticket.id);
        touchedRoomIds.push(room.id);

        const working = await housekeeping.patch(`/api/maintenance/${ticket.id}`, {
            status: 'in_progress',
            assignedTo: null,
        });
        assert.equal(working.status, 200);
        assert.equal(working.body.data.ticket.status, 'in_progress');

        const resolved = await housekeeping.patch(`/api/maintenance/${ticket.id}`, {
            status: 'resolved',
            resolutionNotes: 'Fan bearing replaced',
        });
        assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
        assert.ok(resolved.body.data.ticket.resolvedAt, 'resolution timestamp recorded');

        const roomRows = await select('SELECT status FROM rooms WHERE id = :id', { id: room.id });
        assert.equal(
            roomRows[0].status,
            'cleaning',
            'a repaired room must be inspected before it is sold again',
        );

        // Housekeeping then releases the room itself.
        const { client: staff } = await loginAs('reception@example.com', 'Reception@1234');
        const release = await staff.patch(`/api/rooms/${room.id}/status`, { status: 'available' });
        assert.ok([200, 201].includes(release.status), 'housekeeping room release still works');
    });

    test('cancelling a mistaken ticket returns the room availability', async () => {
        const room = await availableRoom();
        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');

        const created = await housekeeping.post('/api/maintenance', {
            roomId: room.id,
            title: 'Wrong room - booking for 404',
        });
        assert.equal(created.status, 201);
        createdTicketIds.push(created.body.data.ticket.id);
        touchedRoomIds.push(room.id);

        const cancelled = await housekeeping.patch(`/api/maintenance/${created.body.data.ticket.id}`, {
            status: 'cancelled',
            resolutionNotes: 'Raised against the wrong room',
        });
        assert.equal(cancelled.status, 200);

        const roomRows = await select('SELECT status FROM rooms WHERE id = :id', { id: room.id });
        assert.equal(roomRows[0].status, 'available', 'the room was never actually broken');
    });

    test('the board list filters and counts', async () => {
        const { client: housekeeping } = await loginAs('housekeeping@example.com', 'Housekeep@1234');

        const openOnly = await housekeeping.get('/api/maintenance?openOnly=true&limit=50');
        assert.equal(openOnly.status, 200);
        assert.ok(
            openOnly.body.data.every((ticket) => ['open', 'in_progress'].includes(ticket.status)),
        );

        const counts = await housekeeping.get('/api/maintenance/counts');
        assert.equal(counts.status, 200);
        assert.ok('open' in counts.body.data.counts);
        assert.ok('resolved' in counts.body.data.counts);
    });

    test('restaurant staff cannot raise tickets', async () => {
        const { client } = await loginAs('restaurant@example.com', 'Restaurant@1234');

        const response = await client.post('/api/maintenance', {
            title: 'Not a maintenance role',
        });
        assert.equal(response.status, 403);
    });
});
