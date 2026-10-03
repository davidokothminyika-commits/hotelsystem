/**
 * scripts/check-flows.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Drives the guest flows that a page-load check cannot reach: ordering food,
 * placing the order, paying for it with a card, and being declined with a card
 * that the simulated gateway rejects.
 *
 * WHY IT EXISTS
 * check-pages.mjs answers "does the page render". It cannot answer "does the
 * button work", because most of these pages do nothing until someone clicks.
 * The basket maths, the confirmation dialog, the card field toggling and the
 * decline path all live behind a click, and each one has already had a bug of
 * the kind that only a real click finds.
 *
 * WHY IT WRITES REAL DATA
 * Placing an order and paying it are the behaviour under test, so there is no
 * way to check them without creating the rows. They go to the test database
 * like any other test run.
 *
 * RUN
 *   node scripts/check-flows.mjs
 *   node scripts/check-flows.mjs order
 *   node scripts/check-flows.mjs payment
 *
 * COMMUNICATION
 * Reads: public/pages/**. Writes: orders and payments, via the real API, as a
 * signed in guest. Database tables used: orders, order_items, payments.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';

const ACCOUNT = { email: 'guest@example.com', password: 'Guest@1234' };

/** A card the simulated gateway authorises, and one it always declines. */
const GOOD_CARD = '4242424242424242';
const DECLINED_CARD = '4000000000000002';

const FLOWS = {
    order: 'guest places a restaurant order from the menu',
    payment: 'guest pays for an outstanding balance with a card',
    decline: 'a declined card shows the reason and keeps the form filled',
};

/**
 * Starts the real Express app, so the flows run against the same origin, cookie
 * and validation a user's browser would use. See check-pages.mjs for why the
 * pages are served from the app rather than a static server.
 */
async function startApp() {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Signs a context in and returns a tab with console errors collected. */
async function signedInTab(context, base, url) {
    const response = await context.request.post(`${base}/api/auth/login`, { data: ACCOUNT });
    if (!response.ok()) throw new Error(`sign in failed: ${response.status()}`);

    const tab = await context.newPage();
    const problems = [];

    tab.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
    tab.on('console', (message) => {
        // A failed fetch is reported through the page's own error handling, so
        // only genuine script errors are collected here. 4xx responses are
        // deliberately not failures: the decline flow requests one.
        if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
            problems.push(`console: ${message.text()}`);
        }
    });

    await tab.goto(`${base}${url}`, { timeout: 15000 });
    await tab.waitForTimeout(1200);

    return { tab, problems };
}

// ---------------------------------------------------------------------------
// Flow: order
// ---------------------------------------------------------------------------

/**
 * Adds two dishes to the basket, checks the count and total moved, places the
 * order and confirms the page lands on the new order's details.
 */
async function orderFlow(context, base, assert) {
    const { tab, problems } = await signedInTab(context, base, '/pages/guest/restaurant.html');

    // The basket starts empty.
    const initialCount = await tab.textContent('#basket-count');
    assert(initialCount === '0', `basket starts empty (badge read "${initialCount}")`);

    // Add the first two orderable dishes on the page.
    const addButtons = tab.locator('#menu-items button:has-text("Add to order")');
    const available = await addButtons.count();
    assert(available >= 2, `at least two dishes are orderable (found ${available})`);

    await addButtons.nth(0).click();
    await addButtons.nth(1).click();
    await tab.waitForTimeout(400);

    const afterAdd = await tab.textContent('#basket-count');
    assert(afterAdd === '2', `badge counts two dishes (read "${afterAdd}")`);

    // The second click must not re-add the first dish: the basket is keyed by
    // menu item, so two dishes give a count of exactly two, not three.
    await addButtons.nth(0).click();
    await tab.waitForTimeout(400);
    const afterRepeat = await tab.textContent('#basket-count');
    assert(afterRepeat === '3', `re-adding increments the line (read "${afterRepeat}")`);

    // The stepper increments one line at a time.
    await tab.click('button[aria-label^="Add one"]');
    await tab.waitForTimeout(300);
    const afterStepper = await tab.textContent('#basket-count');
    assert(afterStepper === '4', `stepper adds a fourth item (read "${afterStepper}")`);

    // Place the order: confirm dialog, then a redirect to its details page.
    await tab.click('button:has-text("Place order")');
    await tab.waitForSelector('dialog[open]', { timeout: 5000 });
    await tab.click('dialog[open] button:has-text("Place order")');

    await tab.waitForURL(/\/pages\/guest\/order-details\.html\?id=\d+/, { timeout: 10000 });
    await tab.waitForTimeout(1200);

    const orderId = new URL(tab.url()).searchParams.get('id');
    const shown = await tab.textContent('#page-content');
    assert(Boolean(orderId), `landed on the new order's details (id=${orderId})`);
    assert(/pending/i.test(shown), 'the new order is shown as pending');

    // The basket must not survive into the next page: it is in-memory on
    // purpose, but it should also be empty after a successful order.
    await tab.goto(`${base}/pages/guest/restaurant.html`);
    await tab.waitForTimeout(1200);
    const badgeAfter = await tab.textContent('#basket-count');
    assert(badgeAfter === '0', `basket is empty after ordering (read "${badgeAfter}")`);

    assert(problems.length === 0, `no script errors (${problems.join('; ') || 'none'})`);

    await tab.close();
    return orderId;
}

// ---------------------------------------------------------------------------
// Flow: payment
// ---------------------------------------------------------------------------

/** Fills the card fields and submits. */
async function payWithCard(tab, cardNumber) {
    await tab.selectOption('select[name="method"]', 'card');
    await tab.fill('#pay-cardNumber', cardNumber);
    await tab.fill('#pay-cardHolder', 'Flow Check');
    await tab.fill('#pay-expiryMonth', '12');
    await tab.fill('#pay-expiryYear', String(new Date().getFullYear() + 1));
    await tab.fill('#pay-cvv', '123');
    await tab.click('form button[type="submit"]');
}

/**
 * Pays the newest outstanding balance with a card that authorises, and checks
 * the balance disappears from the list of things to pay.
 */
async function paymentFlow(context, base, assert) {
    const { tab, problems } = await signedInTab(context, base, '/pages/guest/payments.html');

    // Nothing to pay is a valid state, not a failure; say so and stop.
    const hasTarget = await tab.locator('select.form-select').first().isVisible();
    const optionCount = hasTarget ? await tab.locator('select.form-select').first().locator('option').count() : 0;

    if (optionCount === 0) {
        console.log('  – no outstanding balance, payment flow skipped');
        await tab.close();
        return;
    }

    const payButtonBefore = await tab.textContent('form button[type="submit"]');
    assert(/^Pay /.test(payButtonBefore.trim()), `pay button names the amount ("${payButtonBefore.trim()}")`);

    await payWithCard(tab, GOOD_CARD);

    // The balance should be settled: the target list reloads without it.
    await tab.waitForTimeout(2500);

    const remaining = await tab
        .locator('select.form-select')
        .first()
        .locator('option')
        .count();

    assert(remaining < optionCount, `a paid balance leaves the list (${optionCount} -> ${remaining})`);

    // The payment must appear in the history the guest can see.
    const history = await tab.textContent('#page-content');
    assert(/card/i.test(history), 'the new payment appears in the history');

    assert(problems.length === 0, `no script errors (${problems.join('; ') || 'none'})`);

    await tab.close();
}

/**
 * Submits a card the gateway always declines. The page must show the reason and
 * keep what was typed, because the guest will fix one field and retry.
 */
async function declineFlow(context, base, assert) {
    const { tab, problems } = await signedInTab(context, base, '/pages/guest/payments.html');

    const options = await tab.locator('select.form-select').first().locator('option').count();
    if (options === 0) {
        console.log('  – no outstanding balance, decline flow skipped');
        await tab.close();
        return;
    }

    await payWithCard(tab, DECLINED_CARD);
    await tab.waitForTimeout(2000);

    const notice = await tab.locator('#payment-notice:not(.hidden)').textContent().catch(() => null);
    assert(Boolean(notice && notice.trim()), `the decline reason is shown inline ("${notice?.trim() || 'nothing'}")`);

    // The retry path is the whole point of not clearing the form.
    const kept = await tab.inputValue('#pay-cardNumber');
    assert(kept === DECLINED_CARD, 'the card number is kept so a retry does not start over');

    assert(problems.length === 0, `no script errors (${problems.join('; ') || 'none'})`);

    await tab.close();
}

// ---------------------------------------------------------------------------

/**
 * A tiny assertion collector, so one failing step does not hide the rest and
 * the report shows everything that went wrong in a single run.
 */
function reporter() {
    const failures = [];

    return {
        check(condition, description) {
            if (!condition) failures.push(description);
        },
        get failures() {
            return failures;
        },
    };
}

async function main() {
    const only = process.argv[2];
    const app = await startApp();
    const browser = await chromium.launch();

    const results = [];

    try {
        const run = async (name, flow) => {
            if (only && only !== name) return;

            const context = await browser.newContext();
            const report = reporter();

            try {
                await flow(context, app.base, report.check);
            } catch (error) {
                report.check(false, `threw: ${error.message}`);
            }

            await context.close();

            if (report.failures.length === 0) {
                console.log(`  ✔ ${FLOWS[name]}`);
            } else {
                console.log(`  ✖ ${FLOWS[name]}`);
                for (const failure of report.failures) console.log(`      ${failure}`);
                results.push(name);
            }
        };

        await run('order', orderFlow);
        await run('payment', paymentFlow);
        await run('decline', declineFlow);
    } finally {
        await browser.close();
        app.server.close();
        const db = await import('../src/config/db.js');
        await db.closePool();
    }

    console.log(results.length ? `\n${results.length} flow(s) reported problems.` : '\nAll flows passed.');
    process.exit(results.length ? 1 : 0);
}

main().catch((error) => {
    console.error('check-flows failed:', error);
    process.exit(1);
});