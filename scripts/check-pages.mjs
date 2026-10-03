/**
 * scripts/check-pages.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Loads every dashboard page in a real browser as a signed-in user and reports
 * any console error, failed request or missing page shell.
 *
 * WHY IT EXISTS
 * These pages are plain ES modules with no build step and no type checker, so
 * nothing catches a bad import or a typo until a browser tries to run it. A page
 * can pass every server-side test and still be a blank screen because one of its
 * modules 404s. This is the only check that sees what the user would see.
 *
 * HOW IT WORKS
 * It signs in through the real login endpoint, reuses the resulting cookie for
 * every page, and loads each one at the URL a user would actually visit. Role
 * guards are exercised too, because the interesting failure is a page that
 * redirects a receptionist away from a screen they should see.
 *
 * RUN
 *   node scripts/check-pages.mjs
 *   node scripts/check-pages.mjs admin          # one area only
 *
 * COMMUNICATION
 * Reads: public/pages/**, which the Express app serves.
 * Database tables used: none directly; it signs in against the running app.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';

const ROOT = process.cwd();

/**
 * Pages to check, grouped by the account that should be able to see them.
 * Each entry is the path relative to /pages, or an object:
 *
 *   { path, query, check }
 *
 *   path   relative to /pages
 *   query  object, or an async resolver given the signed-in request context.
 *          Used for detail pages, which only render with a real id.
 *   check  CSS selector that must render something. Defaults to #page-content,
 *          which the dashboard shell creates. The public auth pages have no
 *          shell, so they are checked on their <main> instead.
 *
 * A resolver that finds nothing skips the page rather than loading it with a
 * made-up id: a detail page given an id that does not exist renders its "not
 * found" state, which would pass the check while testing nothing.
 */
const AREAS = {
    staff: {
        account: { email: 'reception@example.com', password: 'Reception@1234' },
        pages: [
            'staff/reception.html',
            'staff/housekeeping.html',
            'staff/messages.html',
        ],
    },
    admin: {
        account: { email: 'admin@example.com', password: 'Admin@1234' },
        pages: [
            'admin/dashboard.html',
            'admin/bookings.html',
            'admin/rooms.html',
            'admin/orders.html',
            'admin/menu.html',
            'admin/payments.html',
            'admin/invoices.html',
            'admin/users.html',
            'admin/roles.html',
            'admin/reviews.html',
            'admin/messages.html',
            'admin/notifications.html',
            'admin/audit-logs.html',
            'admin/reports.html',
            'admin/settings.html',
        ],
    },
    restaurant: {
        account: { email: 'restaurant@example.com', password: 'Restaurant@1234' },
        pages: ['staff/restaurant.html', 'staff/messages.html'],
    },
    guest: {
        account: { email: 'guest@example.com', password: 'Guest@1234' },
        pages: [
            'guest/dashboard.html',
            'guest/bookings.html',
            { path: 'guest/booking-details.html', query: firstIdOf('/api/bookings') },
            'guest/orders.html',
            { path: 'guest/order-details.html', query: firstIdOf('/api/orders') },
            'guest/payments.html',
            { path: 'guest/payments.html', query: firstIdOf('/api/bookings', 'bookingId') },
            'guest/invoices.html',
            'guest/restaurant.html',
            { path: 'guest/room-details.html', query: firstIdOf('/api/rooms') },
            'guest/reviews.html',
            'guest/messages.html',
            'guest/notifications.html',
            'guest/profile.html',
            'guest/settings.html',
        ],
    },
    // The public pages, checked with no session at all. A signed in browser
    // would follow them straight past the form, which is the one thing worth
    // testing here.
    auth: {
        account: null,
        pages: [{ path: 'auth/forgot-password.html', check: 'main', ignoreStatus: [401] }],
    },
};

/**
 * Builds a query resolver that takes an id from a collection endpoint, so
 * detail pages are opened against a row that actually exists.
 *
 * @param {string} path        Collection endpoint to read.
 * @param {string} [paramName] Query parameter to put the id in.
 */
function firstIdOf(path, paramName = 'id') {
    return async (request, base) => {
        const response = await request.get(`${base}${path}`, { params: { limit: 1 } });
        if (!response.ok()) return null;

        const payload = await response.json();
        const rows = payload?.data;
        const first = Array.isArray(rows) ? rows[0] : null;
        const id = first?.id ?? payload?.data?.room?.id;

        return id == null ? null : { [paramName]: String(id) };
    };
}

/**
 * Pages a role must NOT be able to open. Each must bounce the user to their own
 * landing page and must not fetch the restricted data on the way, because a
 * page that redirects after drawing the table has still leaked it.
 */
const GUARDS = [
    {
        account: { email: 'guest@example.com', password: 'Guest@1234' },
        forbidden: ['admin/dashboard.html', 'admin/users.html', 'admin/audit-logs.html', 'staff/reception.html', 'staff/housekeeping.html'],
        landing: '/pages/guest/dashboard.html',
    },
    {
        account: { email: 'reception@example.com', password: 'Reception@1234' },
        forbidden: ['admin/users.html', 'admin/audit-logs.html', 'admin/settings.html'],
        landing: '/pages/staff/reception.html',
    },
];

/**
 * Starts the real Express app, which serves both /api and the static pages from
 * public/. Loading pages from the app origin rather than a second static server
 * is deliberate: it means the check exercises the same origin, cookie and CSP
 * a real browser would get, so a page that only works when served differently
 * still fails here.
 */
async function startApp() {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
    const only = process.argv[2];

    // 'guards' is not an area; it selects only the role isolation pass.
    const areas = !only ? AREAS : only === 'guards' ? {} : { [only]: AREAS[only] };

    const app = await startApp();

    const browser = await chromium.launch();
    const failures = [];

    try {
        for (const [area, definition] of Object.entries(areas)) {
            const context = await browser.newContext();

            // Sign in once per area and reuse the cookie for every page. An
            // area with no account is checked signed out.
            if (definition.account) {
                const login = await context.newPage();
                await login.goto(`${app.base}/api/health`).catch(() => {});
                const response = await context.request.post(`${app.base}/api/auth/login`, {
                    data: definition.account,
                });

                if (!response.ok()) {
                    failures.push({
                        area,
                        page: 'LOGIN',
                        problems: [`sign in failed: ${response.status()}`],
                    });
                    console.log(`  ✖ ${area}: could not sign in as ${definition.account.email}`);
                    await context.close();
                    continue;
                }
                await login.close();
            }

            for (const entry of definition.pages) {
                const page = typeof entry === 'string' ? entry : entry.path;
                const problems = [];

                // Detail pages need a real id, resolved against the same
                // signed-in session the page will use.
                let query = typeof entry === 'object' && entry.query ? entry.query : null;
                let resolvedQuery = {};

                if (typeof query === 'function') {
                    try {
                        resolvedQuery = (await query(context.request, app.base)) || {};
                    } catch (error) {
                        problems.push(`query resolver failed: ${error.message}`);
                    }

                    if (!Object.keys(resolvedQuery).length && problems.length === 0) {
                        console.log(`  – ${page} (no data to open, skipped)`);
                        continue;
                    }
                } else if (query) {
                    resolvedQuery = query;
                }

                const selector = (typeof entry === 'object' && entry.check) || '#page-content';

                // A signed out page asks who it is and is told 401. That is the
                // correct answer, not a failure, so the browser's own noise
                // about it is filtered out alongside the response itself.
                const ignored = (typeof entry === 'object' && entry.ignoreStatus) || [];
                const keeps = (problem) =>
                    !ignored.some((status) => problem.includes(`http ${status}:`) || problem.includes(`status of ${status}`));
                const search = new URLSearchParams(resolvedQuery).toString();
                const url = `${app.base}/pages/${page}${search ? `?${search}` : ''}`;

                const tab = await context.newPage();

                tab.on('console', (message) => {
                    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
                });
                tab.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
                tab.on('requestfailed', (request) =>
                    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`),
                );
                tab.on('response', (res) => {
                    if (res.status() >= 400) problems.push(`http ${res.status()}: ${res.url()}`);
                });

                try {
                    await tab.goto(url, { timeout: 10000 });
                } catch (error) {
                    problems.push(`navigation failed: ${error.message}`);
                }

                // Generous settle time. Pages fetch several endpoints and then
                // render, and a too-short wait reports a perfectly good page as
                // empty, which trains the reader to ignore the check.
                await tab.waitForTimeout(1500);

                // A shell that never rendered is the classic silent failure.
                const rendered = await tab.evaluate((sel) => {
                    const content = document.querySelector(sel);
                    return {
                        hasShell: Boolean(content),
                        text: (content?.innerText || '').trim().slice(0, 60),
                        redirected: window.location.pathname,
                    };
                }, selector);

                if (!rendered.hasShell) problems.push(`${selector} missing: shell did not build`);
                else if (!rendered.text) problems.push(`${selector} is empty`);
                else if (rendered.redirected.includes('/auth/') && definition.account) {
                    problems.push('redirected to sign in');
                }

                const realProblems = problems.filter(keeps);

                if (realProblems.length) {
                    failures.push({ area, page, problems: realProblems });
                    console.log(`  ✖ ${page}`);
                    for (const problem of [...new Set(realProblems)].slice(0, 6)) {
                        console.log(`      ${problem}`);
                    }
                } else {
                    console.log(`  ✔ ${page}${search ? `?${search}` : ''}`);
                }

                await tab.close();
            }

            await context.close();
        }

        if (!only || only === 'guards') {
            await checkGuards(browser, app, failures);
        }
    } finally {
        await browser.close();
        app.server.close();
        const db = await import('../src/config/db.js');
        await db.closePool();
    }

    console.log(
        failures.length
            ? `\n${failures.length} page(s) reported problems.`
            : '\nAll pages loaded cleanly.',
    );
    process.exit(failures.length ? 1 : 0);
}

/**
 * Verifies that a page a role may not use redirects to that role's own landing
 * page, and that it never requests the restricted endpoints. The second half is
 * the one that matters: a redirect that happens after the table is already on
 * screen has leaked the data even though the address bar looks correct.
 */
async function checkGuards(browser, app, failures) {
    for (const guard of GUARDS) {
        const context = await browser.newContext();

        const response = await context.request.post(`${app.base}/api/auth/login`, { data: guard.account });
        if (!response.ok()) {
            failures.push({ area: 'guards', page: 'LOGIN', problems: [`sign in failed: ${response.status()}`] });
            console.log(`  ✖ guards: could not sign in as ${guard.account.email}`);
            await context.close();
            continue;
        }

        for (const page of guard.forbidden) {
            const problems = [];
            const restricted = [];

            const tab = await context.newPage();

            // Only requests made while the forbidden page is still on screen
            // count. Once the guard redirects, the landing page legitimately
            // fetches its own data, and counting that would report a leak on
            // every correctly guarded page.
            let watching = true;

            tab.on('framenavigated', (frame) => {
                if (frame !== tab.mainFrame()) return;
                if (new URL(frame.url()).pathname !== `/pages/${page}`) watching = false;
            });

            tab.on('response', (res) => {
                if (!watching) return;
                const url = res.url();
                if (!url.startsWith(`${app.base}/api/`) || res.status() !== 200) return;

                // /auth/me is the guard deciding who you are, not the page's
                // data. It is expected on every page.
                if (url.startsWith(`${app.base}/api/auth/me`)) return;

                restricted.push(url);
            });

            await tab.goto(`${app.base}/pages/${page}`, { timeout: 10000 }).catch((error) => {
                problems.push(`navigation failed: ${error.message}`);
            });
            await tab.waitForTimeout(1500);

            const landed = await tab.evaluate(() => window.location.pathname);

            if (landed !== guard.landing) {
                problems.push(`landed on ${landed}, expected ${guard.landing}`);
            }

            if (restricted.length > 0) {
                problems.push(`fetched restricted data: ${restricted.map((u) => u.replace(app.base, '')).join(', ')}`);
            }

            if (problems.length) {
                failures.push({ area: 'guards', page, problems });
                console.log(`  ✖ ${guard.account.email} blocked from ${page}`);
                for (const problem of [...new Set(problems)].slice(0, 4)) console.log(`      ${problem}`);
            } else {
                console.log(`  ✔ ${guard.account.email} blocked from ${page}`);
            }

            await tab.close();
        }

        await context.close();
    }
}

main().catch((error) => {
    console.error('check-pages failed:', error);
    process.exit(1);
});
