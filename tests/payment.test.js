/**
 * tests/payment.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the simulated payment gateway and the money rules that
 * sit on top of it.
 *
 * WHY IT EXISTS
 * A payment system is the easiest place in the application to ship a real bug
 * that looks like it works. The tests below therefore check the money itself,
 * not just the HTTP status: that a decline leaves the balance untouched, that
 * the charged amount is the amount the server computed rather than the amount
 * the client asked for, and that a full card number never reaches the
 * database.
 *
 * RUN
 *   npm test
 *
 * COMMUNICATION
 * Uses: tests/helpers/test-server.js to boot the real app in-process.
 * Database tables used: payments, invoices, bookings, orders, users.
 */
import './helpers/env-setup.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startTestServer,
    stopTestServer,
    TestClient,
    select,
    cleanTestBookings,
    resetRoomStatuses,
    testBookingMarker,
    closePool,
} from './helpers/test-server.js';
import { passesLuhn } from '../src/services/payments/providers/mock.provider.js';
import notificationService from '../src/services/notification.service.js';

/** Cards documented in the UI. */
const CARD_SUCCESS = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const CARD_NO_FUNDS = '4000000000009995';

/**
 * The server is started once for the whole file and torn down once at the end.
 *
 * Per-describe hooks cannot work here. `startTestServer` binds an ephemeral
 * port, and the sign-in clients below are memoised with that port baked in, so
 * stopping the server after the first describe leaves every cached client
 * pointing at a closed port and every later test fails on a connection refused
 * rather than on anything to do with payments.
 */
// Unique to this run, so the startup cleanup reclaims every earlier run's
// bookings without deleting the ones booking.test.js is creating right now.
const RUN_MARKER = testBookingMarker();

before(async () => {
    // These tests book real rooms, so clear anything a previous run left and
    // release rooms a failed run may have stranded mid-cleaning.
    await cleanTestBookings(RUN_MARKER);
    await resetRoomStatuses();
    await startTestServer();
});

after(async () => {
    await stopTestServer();
    await closePool();
});

const sessions = new Map();

/** Memoised sign-in. bcrypt at cost 12 is slow, so log in once per account. */
async function as(email, password) {
    if (!sessions.has(email)) {
        const client = new TestClient();
        const result = await client.post('/api/auth/login', { email, password });
        assert.equal(result.status, 200, `login failed for ${email}`);
        sessions.set(email, client);
    }
    return sessions.get(email);
}

const guest = () => as('guest@example.com', 'Guest@1234');
const receptionist = () => as('reception@example.com', 'Reception@1234');

function dateOnly(daysFromNow) {
    return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Finds a free room for the given window, or null when there is none.
 *
 * Checks for an overlapping booking rather than trusting room status, because
 * status alone does not reflect future reservations.
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
         ORDER BY r.id DESC LIMIT 1`,
        { in: checkIn, out: checkOut },
    );
    return rows.length ? rows[0] : null;
}

/**
 * Windows to try, in order of preference.
 *
 * WHY SEVERAL WINDOWS
 * The test files run in parallel against one database, and the booking suite
 * books the same near-term dates this one uses. Pinning a single window made
 * this suite fail for a reason that has nothing to do with payments: the other
 * suite took the last free room, and the assertion that fired was reported
 * against whichever test happened to be creating a booking. Nothing here
 * depends on the specific dates, only on having an unpaid booking, so the suite
 * now widens the search rather than failing.
 */
const WINDOW_STARTS = [3, 7, 11, 15, 20, 26];

/** Finds a free room in the first window that has one. */
async function freeRoom() {
    for (const start of WINDOW_STARTS) {
        const checkIn = dateOnly(start);
        const checkOut = dateOnly(start + 2);

        const room = await findFreeRoom(checkIn, checkOut);
        if (room) return { room, checkIn, checkOut };
    }

    assert.fail(
        'No free room in any of the test windows. The seeded inventory has been exhausted.',
    );
}

/** Creates a booking owned by the guest, ready to be paid. */
async function createBookableBooking() {
    const { room, checkIn, checkOut } = await freeRoom();

    const created = await (await guest()).post('/api/bookings', {
        roomId: room.id,
        checkIn,
        checkOut,
        guests: 2,
        // The marker `cleanTestBookings` looks for. Without it these rows are
        // indistinguishable from real reservations and are never reclaimed, so
        // repeated runs slowly consume every room in the inventory.
        specialRequests: RUN_MARKER,
    });
    assert.equal(created.status, 201, created.body?.message);

    return { ...created.body.data.booking, roomNumber: room.room_number };
}

/** Creates a pickup order owned by the guest, ready to be paid. */
async function createPayableOrder() {
    const items = await select(
        `SELECT m.id, m.name FROM menu_items m
         JOIN menu_categories c ON c.id = m.category_id
         WHERE m.is_available = 1 AND c.slug = 'dinner'
         LIMIT 1`,
    );
    assert.ok(items.length > 0, 'the seeded menu should have a dinner item');

    const created = await (await guest()).post('/api/orders', {
        items: [{ menuItemId: items[0].id, quantity: 1 }],
        fulfilmentType: 'restaurant_pickup',
    });
    assert.equal(created.status, 201, created.body?.message);

    return created.body.data.order;
}

describe('Payment provider', () => {
    test('the configuration endpoint is public and exposes the test cards', async () => {
        const anonymous = new TestClient();
        const { status, body } = await anonymous.get('/api/payments/config');

        assert.equal(status, 200);
        assert.equal(body.data.provider, 'mock');
        assert.equal(body.data.currency, 'USD');
        assert.deepEqual(
            body.data.methods,
            ['card', 'mobile_money', 'cash'],
        );
        // The form needs these to show the developer how to trigger a decline.
        assert.ok(body.data.testCards.length >= 3);
        assert.equal(body.data.testCards[0].number, CARD_SUCCESS);
    });

    test('the Luhn check accepts real numbers and rejects typos', () => {
        assert.equal(passesLuhn(CARD_SUCCESS), true);
        assert.equal(passesLuhn(CARD_DECLINED), true);
        // Same number with one digit changed.
        assert.equal(passesLuhn('4242424242424243'), false);
        assert.equal(passesLuhn('1234'), false);
        assert.equal(passesLuhn(''), false);
    });

    test('a completed charge stores a masked card and never the full number', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        assert.equal(status, 201, body?.message);

        const rows = await select('SELECT * FROM payments WHERE id = :id', {
            id: body.data.payment.id,
        });
        const stored = JSON.stringify(rows[0]);

        assert.equal(rows[0].status, 'completed');
        assert.ok(!stored.includes(CARD_SUCCESS), 'the full card number must never be stored');
        assert.ok(!stored.includes('"123"'), 'the security code must never be stored');
        // Only the last four survive, which is what a receipt is allowed to show.
        assert.equal(body.data.payment.providerResponse.lastFour, '4242');
        assert.equal(body.data.payment.providerResponse.brand, 'visa');
    });
});

describe('Successful payments', () => {
    test('paying a booking issues an invoice and clears the balance', async () => {
        const booking = await createBookableBooking();
        assert.equal(booking.balanceDue, booking.totalAmount);

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        assert.equal(status, 201, body?.message);

        const { payment, invoice } = body.data;
        assert.equal(payment.status, 'completed');
        assert.equal(invoice.status, 'paid');
        assert.equal(invoice.balanceDue, 0);
        assert.equal(Number(invoice.amountPaid), Number(booking.totalAmount));
        assert.ok(invoice.invoiceNumber.startsWith('INV-'));

        // The invoice lines must add up to the total that was charged. A guest
        // who adds up their bill must get the number printed on it.
        const summed =
            Number(invoice.subtotal) + Number(invoice.taxAmount) + Number(invoice.serviceCharge);
        assert.equal(Number(summed.toFixed(2)), Number(invoice.totalAmount));
        assert.equal(Number(invoice.totalAmount), Number(booking.totalAmount));

        // The booking's own balance must reflect the payment.
        const refreshed = await (await guest()).get(`/api/bookings/${booking.id}`);
        assert.equal(Number(refreshed.body.data.booking.amountPaid), Number(booking.totalAmount));
        assert.equal(refreshed.body.data.booking.balanceDue, 0);
    });

    test('paying an order issues its own invoice', async () => {
        const order = await createPayableOrder();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'order',
            id: order.id,
            method: 'mobile_money',
            mobileNumber: '0712345678',
        });

        assert.equal(status, 201, body?.message);
        assert.equal(body.data.payment.status, 'completed');
        assert.equal(body.data.payment.paymentMethod, 'mobile_money');
        assert.equal(body.data.invoice.orderId, order.id);
        assert.equal(body.data.invoice.status, 'paid');
        // A mobile money number must not be stored in the clear either.
        const rows = await select('SELECT * FROM payments WHERE id = :id', { id: body.data.payment.id });
        assert.ok(!JSON.stringify(rows[0]).includes('0712345678'));
    });

    test('cash payments complete and are flagged as needing settlement', async () => {
        const order = await createPayableOrder();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'order',
            id: order.id,
            method: 'cash',
        });

        assert.equal(status, 201, body?.message);
        assert.equal(body.data.payment.status, 'completed');
        assert.equal(body.data.payment.providerResponse.requiresSettlement, true);
    });

    test('the guest is notified of a successful payment', async () => {
        const before = await notificationService.countUnread(
            (
                await select('SELECT id FROM users WHERE email = :email', {
                    email: 'guest@example.com',
                })
            )[0].id,
        );

        const order = await createPayableOrder();
        await (await guest()).post('/api/payments', {
            entity: 'order',
            id: order.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        const after = await notificationService.countUnread(
            (
                await select('SELECT id FROM users WHERE email = :email', {
                    email: 'guest@example.com',
                })
            )[0].id,
        );

        assert.ok(after > before, 'a completed payment must raise a notification');
    });
});

describe('Declined and cancelled payments', () => {
    test('a bank decline returns 402 with the gateway message', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_DECLINED,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        assert.equal(status, 402);
        assert.equal(body.code, 'CARD_DECLINED');
        assert.match(body.message, /declined/i);

        // A decline must not move the balance.
        const refreshed = await (await guest()).get(`/api/bookings/${booking.id}`);
        assert.equal(Number(refreshed.body.data.booking.amountPaid), 0);
        assert.equal(refreshed.body.data.booking.balanceDue, booking.totalAmount);
    });

    test('an insufficient funds card is distinguished from a generic decline', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_NO_FUNDS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        assert.equal(status, 402);
        assert.equal(body.code, 'INSUFFICIENT_FUNDS');
    });

    test('a cancelled payment is recorded and leaves the balance alone', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
            outcome: 'cancel',
        });

        assert.equal(status, 402);
        assert.equal(body.code, 'PAYMENT_FAILED');

        const refreshed = await (await guest()).get(`/api/bookings/${booking.id}`);
        assert.equal(Number(refreshed.body.data.booking.amountPaid), 0);
    });

    test('a decline is still recorded, so the audit trail is complete', async () => {
        const booking = await createBookableBooking();

        await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_DECLINED,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        // A decline is a real event. If it were not stored, support could not
        // see that a guest ever tried to pay.
        const rows = await select(
            `SELECT * FROM payments WHERE booking_id = :id AND status = 'failed'`,
            { id: booking.id },
        );
        assert.equal(rows.length, 1);
        assert.ok(rows[0].payment_reference, 'a failed attempt still needs a reference');
        assert.match(rows[0].failure_reason, /declined/i);
    });

    test('a guest can retry successfully after a decline', async () => {
        const booking = await createBookableBooking();

        const declined = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_DECLINED,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });
        assert.equal(declined.status, 402);

        const retried = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        assert.equal(retried.status, 201, retried.body?.message);
        assert.equal(retried.body.data.invoice.status, 'paid');
    });
});

describe('Payment validation and authorisation', () => {
    test('a card payment with missing fields is rejected', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
        });

        assert.equal(status, 422);
        assert.ok(body.errors, 'field level errors are expected');
    });

    test('mobile money requires a mobile number', async () => {
        const order = await createPayableOrder();

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'order',
            id: order.id,
            method: 'mobile_money',
        });

        assert.equal(status, 422);
        assert.ok(body.errors);
    });

    test('an unknown payment method is rejected', async () => {
        const order = await createPayableOrder();

        const { status } = await (await guest()).post('/api/payments', {
            entity: 'order',
            id: order.id,
            method: 'bitcoin',
        });

        assert.equal(status, 422);
    });

    test('the amount charged is the server total, never a client supplied one', async () => {
        const booking = await createBookableBooking();

        // A malicious client tries to dictate its own price.
        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
            amount: 0.01,
            currency: 'EUR',
        });

        assert.equal(status, 201, body?.message);
        assert.equal(Number(body.data.payment.amount), Number(booking.totalAmount));
        assert.equal(body.data.payment.currency, 'USD');
    });

    test('a guest cannot pay for someone else booking', async () => {
        const booking = await createBookableBooking();
        const other = await as('sarah@example.com', 'Guest@1234');

        const { status, body } = await other.post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        // 404 rather than 403, so the endpoint does not confirm it exists.
        assert.equal(status, 404);
        assert.equal(body.code, 'BOOKING_NOT_FOUND');
    });

    test('paying an already paid booking is rejected', async () => {
        const booking = await createBookableBooking();

        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });
        assert.equal(paid.status, 201);

        const again = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        assert.equal(again.status, 400);
        assert.equal(again.body.code, 'ALREADY_PAID');
    });

    test('paying a cancelled booking is rejected', async () => {
        const booking = await createBookableBooking();

        await (await guest()).post(`/api/bookings/${booking.id}/cancel`, {
            reason: 'Automated payment test',
        });

        const { status, body } = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'BOOKING_CANCELLED');
    });

    test('paying requires authentication', async () => {
        const anonymous = new TestClient();
        const { status } = await anonymous.post('/api/payments', {
            entity: 'booking',
            id: 1,
            method: 'cash',
        });

        assert.equal(status, 401);
    });

    test('a guest cannot see another guest payment history', async () => {
        const booking = await createBookableBooking();
        await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        const other = await as('david@example.com', 'Guest@1234');
        const mine = await other.get('/api/payments?limit=100');

        assert.equal(mine.status, 200);
        const leaked = mine.body.data.some((payment) => payment.bookingId === booking.id);
        assert.equal(leaked, false, 'payment history must be scoped to the signed in guest');
    });

    test('a guest cannot read another guest payment', async () => {
        const booking = await createBookableBooking();
        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        const other = await as('david@example.com', 'Guest@1234');
        const { status, body } = await other.get(`/api/payments/${paid.body.data.payment.id}`);

        assert.equal(status, 404);
        assert.equal(body.code, 'PAYMENT_NOT_FOUND');
    });
});

describe('Refunds', () => {
    test('staff can refund a completed payment', async () => {
        const booking = await createBookableBooking();
        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });
        assert.equal(paid.status, 201);

        const { status, body } = await (await receptionist()).post(
            `/api/payments/${paid.body.data.payment.id}/refund`,
            { reason: 'Automated refund test' },
        );

        assert.equal(status, 200, body?.message);
        assert.equal(body.data.payment.status, 'refunded');
        assert.ok(body.data.payment.refundedAt, 'a refund must be timestamped');
    });

    test('a guest cannot refund their own payment', async () => {
        const booking = await createBookableBooking();
        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        const { status } = await (await guest()).post(
            `/api/payments/${paid.body.data.payment.id}/refund`,
            { reason: 'Changed my mind' },
        );

        assert.equal(status, 403);
    });

    test('a failed payment cannot be refunded', async () => {
        const booking = await createBookableBooking();
        const declined = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_DECLINED,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        // The error middleware publishes `details` under `errors`, the same key
        // every other failure envelope in the API uses.
        const paymentId = declined.body.errors?.payment?.id;
        assert.ok(paymentId, 'a decline must return the recorded payment');

        const { status, body } = await (await receptionist()).post(
            `/api/payments/${paymentId}/refund`,
            { reason: 'Automated refund test' },
        );

        assert.equal(status, 400);
        assert.equal(body.code, 'NOT_REFUNDABLE');
    });
});

describe('Invoices and receipts', () => {
    test('an unpaid booking returns a proforma rather than an error', async () => {
        const booking = await createBookableBooking();

        const { status, body } = await (await guest()).get(
            `/api/invoices/receipt?entity=booking&id=${booking.id}`,
        );

        assert.equal(status, 200);
        assert.equal(body.data.invoice.isProforma, true);
        assert.equal(Number(body.data.invoice.balanceDue), Number(booking.totalAmount));
    });

    test('a paid booking returns the issued invoice', async () => {
        const booking = await createBookableBooking();
        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        const { status, body } = await (await guest()).get(
            `/api/invoices/receipt?entity=booking&id=${booking.id}`,
        );

        assert.equal(status, 200);
        assert.equal(body.data.invoice.isProforma, undefined);
        assert.equal(body.data.invoice.status, 'paid');
        assert.equal(
            body.data.invoice.invoiceNumber,
            paid.body.data.invoice.invoiceNumber,
        );
    });

    test('the outstanding balance falls as payments succeed', async () => {
        const before = await (await guest()).get('/api/payments/balance');
        assert.ok(before.status === 200);

        const booking = await createBookableBooking();

        const mid = await (await guest()).get('/api/payments/balance');
        assert.ok(
            Number(mid.body.data.outstanding) > Number(before.body.data.outstanding),
            'an unpaid booking must increase the outstanding balance',
        );

        await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        const after = await (await guest()).get('/api/payments/balance');
        assert.ok(
            Number(after.body.data.outstanding) < Number(mid.body.data.outstanding),
            'paying must reduce the outstanding balance',
        );
    });

    test('a guest cannot read another guest invoice', async () => {
        const booking = await createBookableBooking();
        const paid = await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'cash',
        });

        const other = await as('sarah@example.com', 'Guest@1234');
        const { status, body } = await other.get(
            `/api/invoices/${paid.body.data.invoice.id}`,
        );

        assert.equal(status, 404);
        assert.equal(body.code, 'INVOICE_NOT_FOUND');
    });

    test('one invoice per booking, even when payment is retried', async () => {
        const booking = await createBookableBooking();

        await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_DECLINED,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });
        await (await guest()).post('/api/payments', {
            entity: 'booking',
            id: booking.id,
            method: 'card',
            cardNumber: CARD_SUCCESS,
            cardHolder: 'Test Guest',
            expiryMonth: 12,
            expiryYear: 2030,
            cvv: '123',
        });

        const rows = await select('SELECT * FROM invoices WHERE booking_id = :id', { id: booking.id });
        // A decline must not have produced a second, competing receipt.
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].balance_due), 0);
    });
});
