/**
 * tests/rates.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for dynamic pricing: the quote engine, rule management,
 * and the property that matters most - that a booking created while a rule is
 * active is actually priced by it, and that with no rules nothing changes.
 *
 * WHY EVERY RULE WINDOW IS FAR AHEAD
 * Other suites book rooms 60-200 days ahead and assert exact arithmetic on
 * their own bookings. A rule whose window reaches those dates would change
 * their numbers, which is why this suite quotes and books 315+ days out and
 * deletes its rules in teardown.
 *
 * RUN
 *   node --test tests/rates.test.js
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
    testBookingMarker,
} from './helpers/test-server.js';

const RUN_MARKER = testBookingMarker();
const RULE_PREFIX = 'zz-rate-test';

const createdRuleNames = [];
const createdBookingIds = [];

before(async () => {
    // A failed run must not leave a rule active in the shared database.
    await execute(`DELETE FROM rate_rules WHERE name LIKE '${RULE_PREFIX}%'`).catch(() => {});
    await cleanTestBookings(RUN_MARKER);
    await startTestServer();
});

after(async () => {
    await execute(`DELETE FROM rate_rules WHERE name LIKE '${RULE_PREFIX}%'`).catch(() => {});
    for (const id of createdBookingIds) {
        await execute('DELETE FROM bookings WHERE id = :id', { id }).catch(() => {});
    }
    await cleanTestBookings(RUN_MARKER);
    await stopTestServer();
    await closePool();
});

function stayWindow(offsetDays = 315, nights = 2) {
    const pad = (value) => String(value).padStart(2, '0');
    const toIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const start = new Date();
    start.setDate(start.getDate() + offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + nights);
    return { checkIn: toIso(start), checkOut: toIso(end) };
}

async function firstAvailableRoom() {
    const client = new TestClient();
    const window = stayWindow();
    const result = await client.get(
        `/api/rooms/availability?guests=1&checkIn=${window.checkIn}&checkOut=${window.checkOut}&limit=1`,
    );
    assert.equal(result.status, 200);
    assert.ok(result.body.data.length > 0, 'seeded data has rooms');
    return result.body.data[0];
}

async function loginManager() {
    return loginAs('manager@example.com', 'Manager@1234');
}

describe('Dynamic pricing', () => {
    test('guests cannot read rules or quotes', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');

        assert.equal((await client.get('/api/rates')).status, 403);
        assert.equal(
            (await client.get(`/api/rates/quote?roomId=1&checkIn=${stayWindow().checkIn}&checkOut=${stayWindow().checkOut}`)).status,
            403,
        );
    });

    test('with no rules a quote equals the stored base rate', async () => {
        const { client } = await loginManager();
        const room = await firstAvailableRoom();
        const window = stayWindow();

        const response = await client.get(
            `/api/rates/quote?roomId=${room.id}&checkIn=${window.checkIn}&checkOut=${window.checkOut}`,
        );

        assert.equal(response.status, 200, JSON.stringify(response.body));
        const quote = response.body.data.quote;

        assert.equal(quote.baseRate, room.pricePerNight);
        assert.equal(quote.pricePerNight, room.pricePerNight);
        assert.equal(quote.extras, 0);
        assert.deepEqual(quote.applied, []);
        assert.ok(quote.nightlyRates.every((rate) => rate === room.pricePerNight));
        assert.ok(quote.occupancyPercent >= 0, 'occupancy is reported even when unused');
    });

    test('a date range percent rule is applied and explainable', async () => {
        const { client } = await loginManager();
        const room = await firstAvailableRoom();
        const window = stayWindow(320);

        const created = await client.post('/api/rates', {
            name: `${RULE_PREFIX} festival week`,
            triggerType: 'date_range',
            startDate: window.checkIn,
            endDate: window.checkIn, // one night long
            adjustmentType: 'percent',
            adjustmentValue: 15,
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        createdRuleNames.push(created.body.data.rule.name);
        assert.equal(created.body.data.rule.triggerType, 'date_range');

        const quote = await client.get(
            `/api/rates/quote?roomId=${room.id}&checkIn=${window.checkIn}&checkOut=${window.checkOut}`,
        );
        assert.equal(quote.status, 200);
        const data = quote.body.data.quote;

        assert.equal(
            data.nightlyRates[0],
            Number((room.pricePerNight * 1.15).toFixed(2)),
            'the first night carries the +15%',
        );
        assert.equal(data.nightlyRates[1], room.pricePerNight, 'the window is one night long');
        assert.equal(data.applied.length, 1);
        assert.equal(data.applied[0].name, `${RULE_PREFIX} festival week`);
        assert.ok(data.applied[0].description.includes('15%'));

        // mean of nightly, so a two-night stay with one adjusted night quotes
        // the average - the stored booking arithmetic stays exact.
        assert.equal(
            data.pricePerNight,
            Number(((data.nightlyRates[0] + data.nightlyRates[1]) / 2).toFixed(2)),
        );
    });

    test('a fixed rule adds its amount exactly, once per night', async () => {
        const { client } = await loginManager();
        const room = await firstAvailableRoom();
        const window = stayWindow(325);

        const created = await client.post('/api/rates', {
            name: `${RULE_PREFIX} service uplift`,
            triggerType: 'date_range',
            startDate: window.checkIn,
            endDate: window.checkOut,
            adjustmentType: 'fixed',
            adjustmentValue: 5,
        });
        assert.equal(created.status, 201);
        createdRuleNames.push(created.body.data.rule.name);

        const quote = await client.get(
            `/api/rates/quote?roomId=${room.id}&checkIn=${window.checkIn}&checkOut=${window.checkOut}`,
        );
        const nightly = quote.body.data.quote.nightlyRates;
        assert.deepEqual(nightly, nightly.map(() => Number((room.pricePerNight + 5).toFixed(2))));
    });

    test('an occupancy rule applies from the live fill of the window', async () => {
        const { client } = await loginManager();
        const room = await firstAvailableRoom();
        const window = stayWindow(330);

        const created = await client.post('/api/rates', {
            name: `${RULE_PREFIX} demand uplift`,
            triggerType: 'occupancy',
            occupancyThreshold: 0, // always met, so the outcome is deterministic
            adjustmentType: 'percent',
            adjustmentValue: 10,
        });
        assert.equal(created.status, 201);
        createdRuleNames.push(created.body.data.rule.name);

        const quote = await client.get(
            `/api/rates/quote?roomId=${room.id}&checkIn=${window.checkIn}&checkOut=${window.checkOut}`,
        );
        const data = quote.body.data.quote;
        assert.equal(
            data.nightlyRates[0],
            Number((room.pricePerNight * 1.1).toFixed(2)),
            'occupancy >= 0% is always true',
        );

        // Deactivating the rule reverts the price without touching the room.
        const ruleId = (await client.get('/api/rates?search=' + encodeURIComponent(created.body.data.rule.name)))
            .body.data[0].id;
        const patched = await client.patch(`/api/rates/${ruleId}`, { isActive: false });
        assert.equal(patched.status, 200);
        assert.equal(patched.body.data.rule.isActive, false);

        const reverted = await client.get(
            `/api/rates/quote?roomId=${room.id}&checkIn=${window.checkIn}&checkOut=${window.checkOut}`,
        );
        assert.equal(reverted.body.data.quote.pricePerNight, room.pricePerNight, 'inactive rules do nothing');
    });

    test('availability search shows quoted prices to the guest', async () => {
        const { client: manager } = await loginManager();
        const window = stayWindow(335);

        const created = await manager.post('/api/rates', {
            name: `${RULE_PREFIX} search uplift`,
            triggerType: 'date_range',
            startDate: window.checkIn,
            endDate: window.checkIn,
            adjustmentType: 'percent',
            adjustmentValue: 20,
        });
        assert.equal(created.status, 201);
        createdRuleNames.push(created.body.data.rule.name);

        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const search = await guest.get(
            `/api/rooms/availability?guests=1&checkIn=${window.checkIn}&checkOut=${window.checkOut}&limit=5`,
        );
        assert.equal(search.status, 200);
        const room = search.body.data[0];

        assert.ok('quotedPricePerNight' in room, 'the quoted rate is part of the contract');
        assert.equal(
            room.quotedPricePerNight,
            Number((room.pricePerNight * 1.2).toFixed(2)),
            'the card shows the rule-priced stay rate',
        );
        assert.equal(room.priceAdjusted, true, 'the frontend can tell when a rule moved the price');
    });

    test('a booking created under a rule is priced by it', async () => {
        const { client: manager } = await loginManager();
        const window = stayWindow(340);

        const created = await manager.post('/api/rates', {
            name: `${RULE_PREFIX} booking uplift`,
            triggerType: 'date_range',
            startDate: window.checkIn,
            endDate: window.checkIn,
            adjustmentType: 'percent',
            adjustmentValue: 25,
        });
        assert.equal(created.status, 201);
        createdRuleNames.push(created.body.data.rule.name);

        const { client: guest } = await loginAs('guest@example.com', 'Guest@1234');
        const search = await guest.get(
            `/api/rooms/availability?guests=1&checkIn=${window.checkIn}&checkOut=${window.checkOut}&limit=1`,
        );
        assert.equal(search.status, 200);
        const room = search.body.data[0];

        const booking = await guest.post('/api/bookings', {
            roomId: room.id,
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            guests: 1,
            specialRequests: RUN_MARKER,
        });
        assert.equal(booking.status, 201, JSON.stringify(booking.body));
        createdBookingIds.push(booking.body.data.booking.id);

        const stored = booking.body.data.booking;
        assert.ok(
            stored.pricePerNight > room.pricePerNight,
            `booked at the quoted rate (${stored.pricePerNight}) over the base (${room.pricePerNight})`,
        );
        assert.equal(
            stored.pricePerNight,
            Number((room.pricePerNight * 1.25).toFixed(2)),
            'the stored rate is the quoted one-nighth average',
        );
        assert.equal(
            stored.subtotal,
            Number((stored.pricePerNight * stored.nights).toFixed(2)),
            'the invariant price * nights == subtotal survives dynamic pricing',
        );
    });

    test('rule validation and lifecycle', async () => {
        const { client } = await loginManager();

        const badWindow = await client.post('/api/rates', {
            name: `${RULE_PREFIX} bad window`,
            triggerType: 'date_range',
            startDate: stayWindow().checkIn,
            adjustmentType: 'percent',
            adjustmentValue: 10,
        });
        assert.equal(badWindow.status, 400, 'a date range rule needs both ends');

        const noThreshold = await client.post('/api/rates', {
            name: `${RULE_PREFIX} bad occupancy`,
            triggerType: 'occupancy',
            adjustmentType: 'percent',
            adjustmentValue: 10,
        });
        assert.equal(noThreshold.status, 400, 'an occupancy rule needs a threshold');

        const zeroAdjustment = await client.post('/api/rates', {
            name: `${RULE_PREFIX} zero`,
            triggerType: 'date_range',
            startDate: stayWindow().checkIn,
            endDate: stayWindow().checkOut,
            adjustmentType: 'fixed',
            adjustmentValue: 0,
        });
        assert.ok([400, 422].includes(zeroAdjustment.status), 'a zero adjustment is meaningless');

        // Duplicates are a conflict, not a 500.
        const first = await client.post('/api/rates', {
            name: `${RULE_PREFIX} named`,
            triggerType: 'date_range',
            startDate: stayWindow().checkIn,
            endDate: stayWindow().checkIn,
            adjustmentType: 'fixed',
            adjustmentValue: 3,
        });
        assert.equal(first.status, 201);
        createdRuleNames.push(first.body.data.rule.name);

        const duplicate = await client.post('/api/rates', {
            name: `${RULE_PREFIX} named`,
            triggerType: 'date_range',
            startDate: stayWindow().checkIn,
            endDate: stayWindow().checkIn,
            adjustmentType: 'fixed',
            adjustmentValue: 4,
        });
        assert.equal(duplicate.status, 409);

        const deleted = await client.delete(`/api/rates/${first.body.data.rule.id}`);
        assert.equal(deleted.status, 200);
        const gone = await select(
            'SELECT COUNT(*) AS total FROM rate_rules WHERE name = :name',
            { name: `${RULE_PREFIX} named` },
        );
        assert.equal(Number(gone[0].total), 0);
        createdRuleNames.pop();
    });
});
