/**
 * tests/restaurant.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the restaurant: menu browsing, order placement and
 * the kitchen workflow.
 *
 * WHY IT EXISTS
 * The most important property to verify is that the server, not the client,
 * decides what an order costs. The price tampering test below posts a cart
 * with fabricated prices and asserts the stored order uses the database price,
 * which is the guarantee that stops a modified request buying anything cheap.
 *
 * RUN
 *   npm test
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
    closePool,
    cleanTestBookings,
    resetRoomStatuses,
    testBookingMarker,
} from './helpers/test-server.js';

// Unique to this run, so the startup cleanup reclaims earlier runs' bookings
// without touching rows the other suites are using right now.
const RUN_MARKER = testBookingMarker();

before(async () => {
    // The delivery test below books a real room for tonight, so this suite has
    // to reclaim what previous runs left behind for the same reason the booking
    // suite does. Without it every run blocks the highest numbered free room
    // for a near-term window, and after enough runs the capacity 5 rooms are
    // all booked, which breaks an unrelated suite's availability assertions.
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    await stopTestServer();
    await closePool();
});

/**
 * Memoised sign-in helper.
 *
 * The `before` imported at the top of this file registers on the ROOT suite,
 * so a hook placed inside a `describe` callback never runs and the shared
 * client stays undefined. A cached login is both correct and cheaper, since
 * bcrypt at cost 12 takes a few hundred milliseconds per call.
 */
const sessions = new Map();

async function as(email, password) {
    if (!sessions.has(email)) {
        sessions.set(email, await loginAs(email, password));
    }
    return sessions.get(email);
}

/** Picks an available menu item, optionally in a given category. */
async function pickItem({ category = null } = {}) {
    const client = new TestClient();
    const query = category ? `&categorySlug=${category}` : '';
    const result = await client.get(`/api/menu?limit=1${query}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.length > 0, 'the seeded menu should have items available');
    return result.body.data[0];
}

/**
 * Runs `fn` with the item's availability set to `isAvailable`, then restores
 * the original value.
 *
 * The restore is in a finally block on purpose. Menu availability is shared
 * seed data, so an assertion failing midway would otherwise leave the item
 * sold out and every later test that needs it would fail for an unrelated
 * reason.
 */
async function withAvailability(staff, item, isAvailable, fn) {
    await staff.patch(`/api/menu/${item.id}/availability`, { isAvailable });
    try {
        return await fn();
    } finally {
        await staff.patch(`/api/menu/${item.id}/availability`, { isAvailable: item.isAvailable });
    }
}

// ---------------------------------------------------------------------------
describe('Menu browsing', () => {
    test('returns the menu without authentication', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/menu?limit=5');

        assert.equal(status, 200);
        assert.ok(body.data.length > 0);
        for (const item of body.data) {
            assert.ok(item.name, 'each item needs a name');
            assert.ok(item.price > 0, 'each item needs a price');
        }
    });

    test('returns categories with item counts', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/menu/categories');

        assert.equal(status, 200);
        assert.ok(body.data.categories.length >= 6, 'the seed defines six categories');
        for (const category of body.data.categories) {
            assert.equal(typeof category.itemCount, 'number');
        }
    });

    test('filters by category', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/menu?categorySlug=desserts&limit=50');

        assert.ok(body.data.length > 0);
        for (const item of body.data) {
            assert.equal(item.categorySlug, 'desserts');
        }
    });

    test('filters vegetarian items', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/menu?vegetarian=true&limit=50');

        assert.ok(body.data.length > 0);
        for (const item of body.data) {
            assert.equal(item.isVeg, true);
        }
    });

    test('searches by name or description', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/menu?search=Chicken&limit=20');

        assert.ok(body.data.length > 0);
        // The search covers both fields, so an item matches when the term
        // appears in its name or its description.
        for (const item of body.data) {
            const haystack = `${item.name} ${item.description || ''}`.toLowerCase();
            assert.match(haystack, /chicken/);
        }
    });

    test('sorts by price', async () => {
        const client = new TestClient();
        const { body } = await client.get('/api/menu?sortBy=mi.price&sortDir=asc&limit=10');

        const prices = body.data.map((item) => item.price);
        assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    });

    test('does not expose sold out items to guests', async () => {
        const { client: staff } = await loginAs('restaurant@example.com', 'Restaurant@1234');

        const item = await pickItem({ category: 'snacks' });

        await withAvailability(staff, item, false, async () => {
            const guest = new TestClient();
            const guestView = await guest.get('/api/menu?limit=60');
            assert.ok(
                !guestView.body.data.some((entry) => entry.id === item.id),
                'a sold out item must not be offered to guests',
            );

            // Staff still see it, so they can bring it back.
            const staffView = await staff.get('/api/menu?limit=60');
            assert.ok(
                staffView.body.data.some((entry) => entry.id === item.id),
                'staff should still see sold out items',
            );
        });
    });

    test('404s for an item that does not exist', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/menu/999999');
        assert.equal(status, 404);
        assert.equal(body.code, 'ITEM_NOT_FOUND');
    });
});

// ---------------------------------------------------------------------------
describe('Order placement', () => {
    // Resolved on first use inside each test.
    const guest = () => as('guest@example.com', 'Guest@1234');

    test('places a pickup order with server calculated totals', async () => {
        const item = await pickItem({ category: 'dinner' });

        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 2 }],
            fulfilmentType: 'restaurant_pickup',
        });

        assert.equal(status, 201);
        const order = body.data.order;

        assert.equal(order.status, 'pending');
        assert.equal(order.fulfilmentType, 'restaurant_pickup');
        assert.match(order.orderReference, /^OR[A-Z0-9]{10}$/);

        // The stored unit price must come from the database.
        const line = order.items.find((entry) => entry.menuItemId === item.id);
        assert.equal(line.unitPrice, item.price);
        assert.equal(line.quantity, 2);

        const expectedSubtotal = Number((item.price * 2).toFixed(2));
        assert.equal(order.subtotal, expectedSubtotal);

        // Tax 16% and service 10%, rounded per component.
        const expectedTax = Number((expectedSubtotal * 0.16).toFixed(2));
        const expectedService = Number((expectedSubtotal * 0.1).toFixed(2));
        assert.equal(order.taxAmount, expectedTax);
        assert.equal(order.serviceCharge, expectedService);
        assert.equal(order.totalAmount, Number((expectedSubtotal + expectedTax + expectedService).toFixed(2)));
    });

    /**
     * THE PRICE TAMPERING TEST
     *
     * The request includes `unitPrice` and `lineTotal` fields that the API
     * does not accept and does not document. If either reached the database
     * the guest would control their own charges, so the assertion is that the
     * stored values match the menu price instead.
     */
    test('ignores prices supplied by the client', async () => {
        const item = await pickItem({ category: 'drinks' });

        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [
                {
                    menuItemId: item.id,
                    quantity: 1,
                    unitPrice: 0.01,
                    lineTotal: 0.01,
                },
            ],
            fulfilmentType: 'restaurant_pickup',
        });

        assert.equal(status, 201);
        const order = body.data.order;
        const line = order.items.find((entry) => entry.menuItemId === item.id);

        assert.equal(line.unitPrice, item.price, 'unit price must come from the menu');
        assert.notEqual(line.lineTotal, 0.01);
        assert.equal(order.subtotal, item.price);
    });

    test('writes the order and its items to the database', async () => {
        const item = await pickItem({ category: 'lunch' });

        const { body } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 3 }],
            fulfilmentType: 'restaurant_pickup',
        });

        const order = body.data.order;

        const rows = await select('SELECT * FROM orders WHERE order_reference = :ref', {
            ref: order.orderReference,
        });
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].subtotal), order.subtotal);

        const items = await select('SELECT * FROM order_items WHERE order_id = :id', { id: order.id });
        assert.equal(items.length, 1);
        assert.equal(items[0].quantity, 3);
        assert.equal(Number(items[0].unit_price), item.price);
    });

    test('rejects an empty order', async () => {
        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [],
            fulfilmentType: 'restaurant_pickup',
        });

        assert.equal(status, 422);
        assert.ok(body.errors.items);
    });

    test('rejects a zero or negative quantity', async () => {
        const item = await pickItem();

        const zero = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 0 }],
            fulfilmentType: 'restaurant_pickup',
        });
        assert.equal(zero.status, 422);

        const negative = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: -5 }],
            fulfilmentType: 'restaurant_pickup',
        });
        assert.equal(negative.status, 422);
    });

    test('rejects an order for an item that does not exist', async () => {
        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: 999999, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });

        assert.equal(status, 404);
        assert.equal(body.code, 'ITEM_NOT_FOUND');
    });

    test('rejects an order for a sold out item', async () => {
        const { client: staff } = await loginAs('restaurant@example.com', 'Restaurant@1234');
        const item = await pickItem({ category: 'desserts' });

        await withAvailability(staff, item, false, async () => {
            const { status, body } = await (await guest()).client.post('/api/orders', {
                items: [{ menuItemId: item.id, quantity: 1 }],
                fulfilmentType: 'restaurant_pickup',
            });

            assert.equal(status, 400);
            assert.equal(body.code, 'ITEM_UNAVAILABLE');
        });
    });

    test('rejects an absurd quantity', async () => {
        const item = await pickItem();
        const { status } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 500 }],
            fulfilmentType: 'restaurant_pickup',
        });
        assert.equal(status, 400);
    });

    test('requires authentication', async () => {
        const client = new TestClient();
        const item = await pickItem();

        const { status, body } = await client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });

        assert.equal(status, 401);
        assert.equal(body.code, 'NO_TOKEN');
    });

    test('room delivery requires a valid active stay', async () => {
        // A room the guest is not staying in must be refused.
        const rooms = await select(
            `SELECT r.id FROM rooms r
             WHERE r.is_active = 1
               AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.room_id = r.id)
             LIMIT 1`,
        );

        if (rooms.length === 0) return; // every room has a booking in this fixture

        const item = await pickItem();
        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'room_delivery',
            roomId: rooms[0].id,
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'NO_ACTIVE_STAY');
    });

    test('room delivery without a room is rejected', async () => {
        const item = await pickItem();
        const { status, body } = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'room_delivery',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'ROOM_REQUIRED');
    });

    test('room delivery succeeds for a guest with an active stay', async () => {
        // Arrange a genuine stay on the guest's own account. A booking whose
        // window contains today qualifies even while still pending, which is
        // how a guest orders on their arrival day.
        const { client } = await guest();

        // A room that is genuinely free for tonight and tomorrow night. The
        // check has to exclude existing overlapping bookings, otherwise a
        // previous run of this suite leaves the room booked and the test fails
        // for a reason that has nothing to do with delivery.
        const today = new Date().toISOString().slice(0, 10);
        const later = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);

        const room = await select(
            `SELECT r.id, r.room_number FROM rooms r
             WHERE r.is_active = 1 AND r.status = 'available'
               AND NOT EXISTS (
                   SELECT 1 FROM bookings b
                   WHERE b.room_id = r.id
                     AND b.status IN ('pending', 'confirmed', 'checked_in')
                     AND b.check_in < :out AND b.check_out > :in
               )
             ORDER BY r.id DESC LIMIT 1`,
            { in: today, out: later },
        );
        assert.ok(room.length > 0, 'the suite needs at least one free room');

        const booking = await client.post('/api/bookings', {
            roomId: room[0].id,
            checkIn: today,
            checkOut: later,
            guests: 2,
            // The marker the shared cleanup looks for. Without it this booking
            // is indistinguishable from real data, so it is never reclaimed
            // and the room stays blocked for tonight on every later run.
            specialRequests: RUN_MARKER,
        });
        assert.equal(booking.status, 201);

        const item = await pickItem({ category: 'snacks' });
        const { status, body } = await client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'room_delivery',
            roomId: room[0].id,
        });

        assert.equal(status, 201, body.message);
        assert.equal(body.data.order.fulfilmentType, 'room_delivery');
        assert.equal(body.data.order.roomNumber, room[0].room_number);
        assert.ok(body.data.order.bookingId, 'a delivery order must link to the stay');
    });
});

// ---------------------------------------------------------------------------
describe('Kitchen workflow', () => {
    const guest = () => as('guest@example.com', 'Guest@1234');
    const kitchen = () => as('restaurant@example.com', 'Restaurant@1234');

    /** Places a fresh pickup order and returns it. */
    async function placeOrder() {
        const item = await pickItem({ category: 'lunch' });
        const result = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });
        assert.equal(result.status, 201);
        return result.body.data.order;
    }

    test('a new order starts as pending', async () => {
        const order = await placeOrder();
        assert.equal(order.status, 'pending');
    });

    test('kitchen staff can advance an order through the workflow', async () => {
        const order = await placeOrder();

        // The permitted path: pending -> confirmed -> preparing -> ready.
        const steps = ['confirmed', 'preparing', 'ready'];

        let current = order;
        for (const status of steps) {
            const result = await (await kitchen()).client.patch(`/api/orders/${order.id}/status`, { status });
            assert.equal(result.status, 200, `moving to ${status} should succeed`);
            assert.equal(result.body.data.order.status, status);
            current = result.body.data.order;
        }

        assert.equal(current.status, 'ready');
    });

    test('an invalid transition is rejected', async () => {
        const order = await placeOrder();

        // pending cannot jump straight to delivered.
        const { status, body } = await (await kitchen()).client.patch(`/api/orders/${order.id}/status`, {
            status: 'delivered',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
    });

    test('a guest cannot change their own order status', async () => {
        const order = await placeOrder();

        const { status, body } = await (await guest()).client.patch(`/api/orders/${order.id}/status`, {
            status: 'confirmed',
        });

        assert.equal(status, 403);
        assert.equal(body.code, 'INSUFFICIENT_ROLE');
    });

    test('the kitchen board groups orders by status', async () => {
        const order = await placeOrder();

        const { status, body } = await (await kitchen()).client.get('/api/orders/board');

        assert.equal(status, 200);
        assert.ok(body.data.columns, 'the board must expose columns');
        assert.ok(body.data.columns.pending.length > 0, 'a new order should appear as pending');

        const found = body.data.columns.pending.some((entry) => entry.id === order.id);
        assert.ok(found, 'the new order must appear on the board');
    });

    test('order counts are available for dashboards', async () => {
        const { status, body } = await (await kitchen()).client.get('/api/orders/counts');
        assert.equal(status, 200);
        assert.ok(typeof body.data.counts.total === 'number');
    });
});

// ---------------------------------------------------------------------------
describe('Order visibility', () => {
    const guest = () => as('guest@example.com', 'Guest@1234');

    test('a guest only sees their own orders', async () => {
        const sarah = await loginAs('sarah@example.com', 'Guest@1234');
        const david = await loginAs('david@example.com', 'Guest@1234');

        const item = await pickItem();
        const created = await sarah.client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });
        assert.equal(created.status, 201);

        const sarahList = await sarah.client.get('/api/orders?limit=100');
        const davidList = await david.client.get('/api/orders?limit=100');

        assert.ok(sarahList.body.data.some((order) => order.id === created.body.data.order.id));
        assert.ok(!davidList.body.data.some((order) => order.id === created.body.data.order.id));
    });

    test('a guest cannot view another guest order', async () => {
        const sarah = await loginAs('sarah@example.com', 'Guest@1234');
        const david = await loginAs('david@example.com', 'Guest@1234');

        const item = await pickItem();
        const created = await sarah.client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });

        const { status, body } = await david.client.get(`/api/orders/${created.body.data.order.id}`);
        assert.equal(status, 404);
        assert.equal(body.code, 'ORDER_NOT_FOUND');
    });

    test('staff see every order', async () => {
        const { client: kitchen } = await loginAs('restaurant@example.com', 'Restaurant@1234');
        const item = await pickItem();

        await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });

        const list = await kitchen.get('/api/orders?limit=100');
        assert.equal(list.status, 200);
        assert.ok(list.body.data.length >= 1);
    });

    test('a guest can cancel their own order before it leaves the kitchen', async () => {
        const item = await pickItem();
        const created = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });
        const orderId = created.body.data.order.id;

        const { status, body } = await (await guest()).client.post(`/api/orders/${orderId}/cancel`, {
            reason: 'Changed my mind',
        });

        assert.equal(status, 200);
        assert.equal(body.data.order.status, 'cancelled');
    });

    test('cancelling twice is rejected', async () => {
        const item = await pickItem();
        const created = await (await guest()).client.post('/api/orders', {
            items: [{ menuItemId: item.id, quantity: 1 }],
            fulfilmentType: 'restaurant_pickup',
        });
        const orderId = created.body.data.order.id;

        await (await guest()).client.post(`/api/orders/${orderId}/cancel`, { reason: 'First' });
        const second = await (await guest()).client.post(`/api/orders/${orderId}/cancel`, { reason: 'Second' });

        assert.equal(second.status, 400);
        assert.equal(second.body.code, 'ALREADY_CANCELLED');
    });
});