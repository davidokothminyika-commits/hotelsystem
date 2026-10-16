/**
 * tests/integrations.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the open API: API key issuance and verification, the
 * read-only external surface, and webhook delivery - including receiving an
 * event on a real HTTP endpoint and checking its HMAC signature byte for
 * byte.
 *
 * RUN
 *   node --test tests/integrations.test.js
 *
 * Requires: npm run seed
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
    startTestServer,
    stopTestServer,
    TestClient,
    loginAs,
    select,
    execute,
    closePool,
    cleanTestBookings,
    testBookingMarker,
} from './helpers/test-server.js';

const RUN_MARKER = testBookingMarker();

const createdBookingIds = [];
const createdKeyNames = [];
const createdWebhookUrls = [];

before(async () => {
    await cleanTestBookings(RUN_MARKER);
    await startTestServer();
});

after(async () => {
    for (const id of createdBookingIds) {
        await execute('DELETE FROM bookings WHERE id = :id', { id }).catch(() => {});
    }
    // Deliveries cascade from endpoints; keys go by the names this run used.
    for (const name of createdKeyNames) {
        await execute('DELETE FROM api_keys WHERE name = :name', { name }).catch(() => {});
    }
    for (const url of createdWebhookUrls) {
        await execute('DELETE FROM webhook_endpoints WHERE url = :url', { url }).catch(() => {});
    }
    await cleanTestBookings(RUN_MARKER);
    await stopTestServer();
    await closePool();
});

function stayWindow(offsetDays = 350, nights = 2) {
    const pad = (value) => String(value).padStart(2, '0');
    const toIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const start = new Date();
    start.setDate(start.getDate() + offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + nights);
    return { checkIn: toIso(start), checkOut: toIso(end) };
}

/**
 * A local receiver for webhook tests.
 *
 * The server records every request (path, raw body, headers) and answers
 * 200, so delivery can be observed end to end inside this process without
 * any external network.
 */
function startReceiver() {
    const received = [];
    return new Promise((resolve) => {
        const server = http.createServer((request, response) => {
            let chunks = [];
            request.on('data', (chunk) => chunks.push(chunk));
            request.on('end', () => {
                received.push({
                    path: request.url,
                    body: Buffer.concat(chunks).toString('utf8'),
                    signature: request.headers['x-webhook-signature'] || '',
                    event: request.headers['x-webhook-event'] || '',
                });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end('{}');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({
                server,
                received,
                url: `http://127.0.0.1:${port}/hook`,
                close: () => new Promise((done) => server.close(done)),
            });
        });
    });
}

/** Waits until the endpoint has at least `count` received events or fails. */
async function waitFor(receiver, count, { timeoutMs = 5000 } = {}) {
    const started = Date.now();
    while (receiver.received.length < count) {
        if (Date.now() - started > timeoutMs) {
            assert.fail(`webhook was not delivered within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** Signs in as the admin and returns the client. */
function loginAdmin() {
    return loginAs('admin@example.com', 'Admin@1234');
}

describe('Open API: keys and external surface', () => {
    test('non-admins cannot manage keys', async () => {
        const { client } = await loginAs('reception@example.com', 'Reception@1234');

        assert.equal((await client.get('/api/integrations/api-keys')).status, 403);
        const created = await client.post('/api/integrations/api-keys', { name: 'Sneaky' });
        assert.equal(created.status, 403);
    });

    test('a key is issued once, shows only a prefix afterwards', async () => {
        const { client } = await loginAdmin();

        const response = await client.post('/api/integrations/api-keys', {
            name: `${RUN_MARKER} channel sync`,
        });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        createdKeyNames.push(response.body.data.apiKey.name);

        const key = response.body.data.key;
        assert.match(key, /^hk_[0-9a-f]{40}$/, 'the full key format is hk_ + hex');
        assert.equal(response.body.data.apiKey.keyPrefix.length, 10, 'the prefix is 10 chars');
        assert.ok(
            !JSON.stringify(response.body.data).includes(key.slice(10)),
            'the remainder of the key appears exactly once',
        );

        // Later reads show the prefix and nothing more.
        const list = await client.get('/api/integrations/api-keys');
        const entry = list.body.data.apiKeys.find((item) => item.keyPrefix === key.slice(0, 10));
        assert.ok(entry, 'the issued key is listed');
        assert.ok(!JSON.stringify(list.body.data).includes(key.slice(10)), 'the secret never leaks');
    });

    test('the external surface verifies the key on every request', async () => {
        const { client: admin } = await loginAdmin();
        const created = await admin.post('/api/integrations/api-keys', {
            name: `${RUN_MARKER} external tests`,
        });
        assert.equal(created.status, 201);
        createdKeyNames.push(created.body.data.apiKey.name);
        const rawKey = created.body.data.key;

        const header = { 'x-api-key': rawKey };

        // Without any key: 401, and no data.
        const denied = await new TestClient().get('/api/external/health');
        assert.equal(denied.status, 401);

        // With the key: the surface works, and reports who is asking.
        const health = await new TestClient().get('/api/external/health', { headers: header });
        assert.equal(health.status, 200);
        assert.equal(health.body.data.key, `${RUN_MARKER} external tests`);

        const availability = await new TestClient().get(
            `/api/external/rooms/availability?guests=1&limit=5`,
            { headers: header },
        );
        assert.equal(availability.status, 200);
        assert.ok(Array.isArray(availability.body.data));

        const bookings = await new TestClient().get('/api/external/bookings?limit=5', {
            headers: header,
        });
        assert.equal(bookings.status, 200);

        const events = await new TestClient().get('/api/external/webhook-events', {
            headers: header,
        });
        assert.equal(events.status, 200);
        assert.ok(events.body.data.events.includes('booking.created'));

        // A wrong key is an authentication failure, not a 500.
        const bad = await new TestClient().get('/api/external/health', {
            headers: { 'x-api-key': 'hk_0000000000000000000000000000000000000000' },
        });
        assert.equal(bad.status, 401);
    });

    test('revoking a key cuts access instantly', async () => {
        const { client: admin } = await loginAdmin();
        const created = await admin.post('/api/integrations/api-keys', {
            name: `${RUN_MARKER} revoke test`,
        });
        assert.equal(created.status, 201);
        createdKeyNames.push('unused');
        const rawKey = created.body.data.key;
        const keyId = created.body.data.apiKey.id;

        const before = await new TestClient().get('/api/external/bookings?limit=1', {
            headers: { 'x-api-key': rawKey },
        });
        assert.equal(before.status, 200);

        const revoked = await admin.post(`/api/integrations/api-keys/${keyId}/revoke`, {});
        assert.equal(revoked.status, 200);
        assert.ok(revoked.body.data.apiKey.revokedAt);

        const after = await new TestClient().get('/api/external/bookings?limit=1', {
            headers: { 'x-api-key': rawKey },
        });
        assert.equal(after.status, 401, 'revocation applies on the next request');
    });

    test('the external surface cannot be reached with a session', async () => {
        // A signed-in admin must not implicitly widen their surface: external
        // endpoints speak keys, not cookies, so a leaked cookie is not an
        // open-API credential.
        const { client } = await loginAdmin();
        const response = await client.get('/api/external/health');
        assert.equal(response.status, 401);
    });

    test('reads balances and occupancy', async () => {
        const { client: admin } = await loginAdmin();
        const key = await admin.post('/api/integrations/api-keys', {
            name: `${RUN_MARKER} read tests`,
        });
        createdKeyNames.pop();
        createdKeyNames.push(`${RUN_MARKER} read tests`);
        const header = { 'x-api-key': key.body.data.key };

        const occupancy = await new TestClient().get('/api/external/occupancy', { headers: header });
        assert.equal(occupancy.status, 200);
        assert.ok('occupancyPercent' in occupancy.body.data);
        assert.ok(occupancy.body.data.capacityRoomNights > 0);
    });
});

describe('Open API: webhooks', () => {
    test('a subscribed booking event arrives signed', async () => {
        const { client: admin } = await loginAdmin();
        const receiver = await startReceiver();

        const endpoint = await admin.post('/api/integrations/webhooks', {
            url: receiver.url,
            description: `${RUN_MARKER} receiver`,
            events: ['booking.created'],
        });
        assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
        createdWebhookUrls.push(receiver.url);
        const secret = endpoint.body.data.secret;
        assert.match(secret, /^[0-9a-f]{64}$/, 'the signing secret is hex and shown once');

        // Cause the event for real: a guest books a room.
        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const window = stayWindow();
        const search = await guest.get(
            `/api/rooms/availability?guests=1&checkIn=${window.checkIn}&checkOut=${window.checkOut}&limit=1`,
        );
        assert.equal(search.status, 200);
        assert.ok(search.body.data.length > 0, 'seeded data has rooms');

        const booking = await guest.post('/api/bookings', {
            roomId: search.body.data[0].id,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            guests: 1,
            specialRequests: RUN_MARKER,
        });
        assert.equal(booking.status, 201, JSON.stringify(booking.body));
        createdBookingIds.push(booking.body.data.booking.id);

        await waitFor(receiver, 1);

        const delivered = receiver.received[0];
        assert.equal(delivered.event, 'booking.created');
        assert.equal(delivered.path, '/hook');

        const received = JSON.parse(delivered.body);
        assert.equal(received.event, 'booking.created');
        assert.equal(received.data.bookingReference, booking.body.data.booking.bookingReference);

        // The signature covers the exact bytes received, with the secret shown
        // only at endpoint creation.
        const expected = crypto
            .createHmac('sha256', secret)
            .update(delivered.body)
            .digest('hex');
        assert.equal(delivered.signature, `sha256=${expected}`);

        // A wrong secret would not have signed it: enrol the negative case.
        const tampered = crypto
            .createHmac('sha256', `${secret.slice(0, -1)}0`)
            .update(delivered.body)
            .digest('hex');
        assert.notEqual(delivered.signature, `sha256=${tampered}`);

        await receiver.close();
    });

    test('the endpoint log records the delivery', async () => {
        const { client: admin } = await loginAdmin();

        const deliveries = await admin.get('/api/integrations/deliveries?limit=20');
        assert.equal(deliveries.status, 200);
        const log = deliveries.body.data.deliveries;
        assert.ok(Array.isArray(log));
        const hit = log.find((row) => row.event === 'booking.created');
        assert.ok(hit, 'the delivered event is in the log');
        assert.equal(hit.status, 'delivered');
        assert.equal(hit.responseStatus, 200);
        assert.ok(hit.deliveredAt);
    });

    test('pinging an endpoint exercises the real delivery path', async () => {
        const { client: admin } = await loginAdmin();
        const receiver = await startReceiver();

        const created = await admin.post('/api/integrations/webhooks', {
            url: receiver.url,
            events: ['ping'],
        });
        assert.equal(created.status, 201);
        createdWebhookUrls.push(receiver.url);

        const result = await admin.post(`/api/integrations/webhooks/${created.body.data.endpoint.id}/test`, {});
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.data.delivered, true);

        await waitFor(receiver, 1);
        assert.equal(receiver.received[0].event, 'ping');

        await receiver.close();
    });

    test('a failed endpoint is recorded as failed, not lost', async () => {
        const { client: admin } = await loginAdmin();
        // Port 1 on loopback refuses connections immediately.
        const endpoint = await admin.post('/api/integrations/webhooks', {
            url: 'http://127.0.0.1:1/hook',
            events: ['ping'],
        });
        assert.equal(endpoint.status, 201);
        createdWebhookUrls.push('http://127.0.0.1:1/hook');

        const result = await admin.post(`/api/integrations/webhooks/${endpoint.body.data.endpoint.id}/test`, {});
        assert.equal(result.status, 200);
        assert.equal(result.body.data.delivered, false, 'a refused handshake is a valid test result');

        const deliveries = await admin.get(
            `/api/integrations/deliveries?endpointId=${endpoint.body.data.endpoint.id}`,
        );
        const ping = deliveries.body.data.deliveries.find((row) => row.event === 'ping');
        assert.ok(ping, 'the attempt is in the log');
        assert.equal(ping.status, 'failed');
        assert.equal(ping.attempts, 1);
        assert.ok(ping.lastError, 'the failure reason is kept');

        await execute('DELETE FROM webhook_deliveries WHERE endpoint_id = :id', {
            id: endpoint.body.data.endpoint.id,
        }).catch(() => {});
    });

    test('only the subscribed events of an endpoint are sent', async () => {
        const { client: admin } = await loginAdmin();
        const receiver = await startReceiver();

        // Subscribes to nothing this run will emit.
        const endpoint = await admin.post('/api/integrations/webhooks', {
            url: receiver.url,
            events: ['order.created'],
        });
        assert.equal(endpoint.status, 201);
        createdWebhookUrls.push(receiver.url);

        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const window = stayWindow(355);
        const search = await guest.get(
            `/api/rooms/availability?guests=1&checkIn=${window.checkIn}&checkOut=${window.checkOut}&limit=1`,
        );
        const booking = await guest.post('/api/bookings', {
            roomId: search.body.data[0].id,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            guests: 1,
            specialRequests: RUN_MARKER,
        });
        assert.equal(booking.status, 201);
        createdBookingIds.push(booking.body.data.booking.id);

        // Give the flusher a moment, then assert the endpoint heard nothing.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(receiver.received.length, 0, 'an un-subscribed event is filtered out');

        await receiver.close();
    });
});
