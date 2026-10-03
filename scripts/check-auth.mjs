/**
 * scripts/check-auth.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Walks a new guest through registration, email verification and password
 * reset, driving the real pages in a browser and reporting each assertion.
 *
 * WHY IT EXISTS
 * These three flows are the ones a user cannot retry: a spent or malformed
 * link is their only way back into the account, and every failure mode shows
 * up as a specific message on the page rather than an error. Neither the API
 * tests nor check-pages can see that, because it needs a real token arriving
 * in a real page and then being used twice.
 *
 * HOW IT WORKS
 * It sniffs the verification and reset links out of the development mailer's
 * console output, so the flow runs on exactly what a guest would receive. The
 * rest is ordinary Playwright navigation, asserting on the heading each page
 * ends up showing.
 *
 * RUN
 *   node scripts/check-auth.mjs
 *
 * COMMUNICATION
 * Reads: public/pages/auth/**, which the Express app serves.
 * Database tables used: none directly; it registers against the running app.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';

// Capture the tokens the development mailer prints, so the flow can be driven
// with exactly what a guest would receive in their inbox.
const mailed = [];
const realLog = console.log;
console.log = (...args) => {
    const line = args.join(' ');
    const match = line.match(/\/pages\/auth\/(reset-password|verify-email)\.html\?token=([a-f0-9]+)/);
    if (match) mailed.push({ page: match[1], token: match[2] });
    realLog(...args);
};

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { createApp } = await import('../src/app.js');
const server = createServer(createApp());
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(path, data) {
    const res = await fetch(`${base}/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const problems = [];
const checks = [];
function check(ok, what) {
    checks.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
}

const email = `flow.${Date.now()}@example.com`;
const browser = await chromium.launch();

try {
    // ---------------------------------------------------------------- register
    const reg = await api('/auth/register', {
        firstName: 'Flow',
        lastName: 'Test',
        email,
        phone: '+254700000099',
        password: 'Original@1234',
        confirmPassword: 'Original@1234',
    });
    check(reg.status === 201, `register accepted (${reg.status})`);

    const verifyToken = mailed.find((m) => m.page === 'verify-email')?.token;
    check(Boolean(verifyToken), 'a verification link was mailed');

    // ---------------------------------------------------------------- page loads
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    tab.on('pageerror', (e) => problems.push('uncaught: ' + e.message));
    tab.on('console', (m) => {
        if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
            problems.push('console: ' + m.text());
        }
    });

    // Missing and bogus tokens must explain themselves rather than show a form.
    await tab.goto(`${base}/pages/auth/reset-password.html`);
    await tab.waitForTimeout(1200);
    check((await tab.textContent('h1')) === 'This link is incomplete', 'reset page handles a missing token');

    await tab.goto(`${base}/pages/auth/reset-password.html?token=${'a'.repeat(64)}`);
    await tab.waitForTimeout(2000);
    check((await tab.textContent('h1')) === 'This link has expired', 'reset page rejects a bogus token');

    await tab.goto(`${base}/pages/auth/verify-email.html?token=${'b'.repeat(64)}`);
    await tab.waitForTimeout(2500);
    check((await tab.textContent('h1')) === 'This link no longer works', 'verify page rejects a bogus token');

    // ---------------------------------------------------------------- verify email
    await tab.goto(`${base}/pages/auth/verify-email.html?token=${verifyToken}`);
    await tab.waitForSelector('h1', { timeout: 10000 });
    await tab.waitForTimeout(1500);
    check((await tab.textContent('h1')) === 'Email verified', 'a real verification link confirms the address');

    // The same link a second time must not report success.
    await tab.goto(`${base}/pages/auth/verify-email.html?token=${verifyToken}`);
    await tab.waitForTimeout(2500);
    check(
        (await tab.textContent('h1')) === 'This link no longer works',
        'a spent verification link is refused',
    );

    // ---------------------------------------------------------------- reset password
    await api('/auth/forgot-password', { email });
    const resetToken = mailed.filter((m) => m.page === 'reset-password').pop()?.token;
    check(Boolean(resetToken), 'a reset link was mailed');

    await tab.goto(`${base}/pages/auth/reset-password.html?token=${resetToken}`);
    await tab.waitForSelector('#password', { timeout: 10000 });
    check(true, 'a valid reset link shows the password form');

    // Mismatched confirmation is caught before any request.
    await tab.fill('#password', 'Brandnew@1234');
    await tab.fill('#confirmPassword', 'Different@1234');
    await tab.click('#submit-button');
    await tab.waitForTimeout(500);
    check(
        (await tab.textContent('#confirmPassword-error')) === 'Passwords do not match',
        'a mismatched confirmation is caught on the page',
    );

    // Too short, same.
    await tab.fill('#password', 'short');
    await tab.fill('#confirmPassword', 'short');
    await tab.click('#submit-button');
    await tab.waitForTimeout(500);
    check(
        (await tab.textContent('#password-error')).includes('at least 8'),
        'a short password is caught on the page',
    );

    // A real reset.
    await tab.fill('#password', 'Brandnew@1234');
    await tab.fill('#confirmPassword', 'Brandnew@1234');
    await tab.click('#submit-button');
    await tab.waitForTimeout(2500);
    check((await tab.textContent('h1')) === 'Password updated', 'the password is reset');

    // The link must be single use.
    await tab.goto(`${base}/pages/auth/reset-password.html?token=${resetToken}`);
    await tab.waitForTimeout(2000);
    check((await tab.textContent('h1')) === 'This link has expired', 'a spent reset link is refused');

    // ---------------------------------------------------------------- sign in
    const login = await tab.context().request.post(`${base}/api/auth/login`, {
        data: { email, password: 'Brandnew@1234' },
    });
    check(login.status() === 200, `the new password signs in (${login.status()})`);

    const oldLogin = await tab.context().request.post(`${base}/api/auth/login`, {
        data: { email, password: 'Original@1234' },
    });
    check(oldLogin.status() === 401, `the old password no longer works (${oldLogin.status()})`);

    // ---------------------------------------------------------------- friendly routes
    for (const route of ['/reset-password', '/verify-email']) {
        const res = await fetch(`${base}${route}`);
        check(res.ok, `${route} serves the new page (${res.status})`);
    }

    check(problems.length === 0, `no script errors${problems.length ? ': ' + problems.join('; ') : ''}`);
} finally {
    await browser.close();
    server.close();
    const db = await import('../src/config/db.js');
    await db.closePool();
}

realLog('\n' + checks.join('\n'));
realLog(`\n${checks.filter((c) => c.startsWith('FAIL')).length} failed`);
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);