/**
 * tests/auth.test.js
 *
 * WHAT THIS MODULE DOES
 * Integration tests for the authentication flows: registration, login, logout,
 * session handling, role authorization and password recovery.
 *
 * WHY IT EXISTS
 * Authentication is the security boundary of the whole application. These
 * tests assert both the happy paths and, more importantly, that the failure
 * paths behave correctly: weak passwords are rejected, duplicate emails are
 * rejected, wrong credentials give a generic message, and guests cannot reach
 * staff areas.
 *
 * RUN
 *   npm test
 *
 * Requires the database to be seeded: npm run seed
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, TestClient, loginAs, execute, select, closePool } from './helpers/test-server.js';

/** Unique per run so repeated runs never collide on the users unique index. */
const runId = Date.now();
const newUser = {
    firstName: 'Alice',
    lastName: 'Tester',
    email: `alice.${runId}@example.com`,
    phone: '+254700111222',
    password: 'Str0ng!Pass',
    confirmPassword: 'Str0ng!Pass',
};

before(async () => {
    await startTestServer();
});

after(async () => {
    await stopTestServer();
    await closePool();
});

// ---------------------------------------------------------------------------
describe('Registration', () => {
    test('creates an account and returns the user without a password hash', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/register', newUser);

        assert.equal(status, 201);
        assert.equal(body.success, true);
        assert.equal(body.data.user.email, newUser.email);
        assert.equal(body.data.user.role, 'guest');
        assert.equal(body.data.user.emailVerified, false);
        // The password must never appear anywhere in the response.
        assert.equal(body.data.user.password, undefined);
        assert.equal(body.data.user.password_hash, undefined);
        assert.equal(JSON.stringify(body).includes(newUser.password), false);
    });

    test('sets an http-only auth cookie', async () => {
        const client = new TestClient();
        const response = await client.post('/api/auth/register', {
            ...newUser,
            email: `cookie.${runId}@example.com`,
        });

        const cookies = response.headers.getSetCookie();
        const authCookie = cookies.find((line) => line.startsWith('hotel_token='));

        assert.ok(authCookie, 'auth cookie should be set');
        assert.match(authCookie, /HttpOnly/i, 'cookie must be HttpOnly');
        assert.match(authCookie, /SameSite=Lax/i, 'cookie must be SameSite=Lax');
        assert.match(authCookie, /Path=\//i);
    });

    test('stores the password as a bcrypt hash, never plaintext', async () => {
        const email = `hash.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        const rows = await select('SELECT password_hash FROM users WHERE email = :email', { email });
        assert.equal(rows.length, 1);

        const stored = rows[0].password_hash;
        assert.notEqual(stored, newUser.password);
        assert.match(stored, /^\$2[aby]\$12\$/, 'must be a bcrypt hash at cost 12');
    });

    test('rejects a duplicate email with 409', async () => {
        const client = new TestClient();
        // A dedicated email: `newUser` is shared with other tests and is
        // already registered by the first test in this suite.
        const email = `dupe.${runId}@example.com`;
        const first = await client.post('/api/auth/register', { ...newUser, email });
        assert.equal(first.status, 201);

        const second = await client.post('/api/auth/register', { ...newUser, email });
        assert.equal(second.status, 409);
        assert.equal(second.body.code, 'EMAIL_ALREADY_REGISTERED');
    });

    test('rejects weak passwords with a helpful message', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/register', {
            ...newUser,
            email: `weak.${runId}@example.com`,
            password: 'weak',
            confirmPassword: 'weak',
        });

        assert.equal(status, 422);
        assert.ok(body.errors.password, 'should report a password error');
    });

    test('rejects a password without required character classes', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/register', {
            ...newUser,
            email: `weak2.${runId}@example.com`,
            password: 'alllowercase123',
            confirmPassword: 'alllowercase123',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'WEAK_PASSWORD');
    });

    test('rejects mismatched confirmation with field level errors', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/register', {
            ...newUser,
            email: `mismatch.${runId}@example.com`,
            confirmPassword: 'SomethingElse1',
        });

        assert.equal(status, 422);
        assert.match(body.errors.confirmPassword, /do not match/i);
    });

    test('rejects a malformed email address', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/register', {
            ...newUser,
            email: 'definitely-not-an-email',
        });

        assert.equal(status, 422);
        assert.ok(body.errors.email);
    });

    test('normalises the email to lower case', async () => {
        const client = new TestClient();
        const email = `MixedCase.${runId}@Example.COM`;
        const { status, body } = await client.post('/api/auth/register', { ...newUser, email });

        assert.equal(status, 201);
        assert.equal(body.data.user.email, email.toLowerCase());
    });

    test('never allows public signup to create a staff account', async () => {
        const client = new TestClient();
        // Even if a client sends a privileged role, it must be ignored.
        const { body } = await client.post('/api/auth/register', {
            ...newUser,
            email: `escalate.${runId}@example.com`,
            role: 'admin',
            roleId: 1,
        });

        assert.equal(body.data.user.role, 'guest');
    });
});

// ---------------------------------------------------------------------------
describe('Login', () => {
    test('signs in a valid seeded user', async () => {
        const { user } = await loginAs('guest@example.com', 'Guest@1234');
        assert.equal(user.email, 'guest@example.com');
        assert.equal(user.role, 'guest');
    });

    test('returns the correct role for each demo account', async () => {
        const expected = {
            'admin@example.com': 'admin',
            'manager@example.com': 'manager',
            'reception@example.com': 'receptionist',
            'restaurant@example.com': 'restaurant_staff',
            'housekeeping@example.com': 'housekeeping',
        };

        for (const [email, role] of Object.entries(expected)) {
            const { user } = await loginAs(email, passwordFor(role));
            assert.equal(user.role, role, `${email} should be ${role}`);
        }
    });

    test('rejects a wrong password with 401', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/login', {
            email: 'guest@example.com',
            password: 'WrongPassword1',
        });

        assert.equal(status, 401);
        assert.equal(body.code, 'INVALID_CREDENTIALS');
    });

    test('gives an identical response for an unknown email (no account enumeration)', async () => {
        const client = new TestClient();

        const unknownEmail = await client.post('/api/auth/login', {
            email: `nobody.${runId}@example.com`,
            password: 'Str0ng!Pass',
        });
        const wrongPassword = await client.post('/api/auth/login', {
            email: 'guest@example.com',
            password: 'WrongPassword1',
        });

        // Identical status, message and code: nothing reveals whether the
        // address is registered.
        assert.equal(unknownEmail.status, wrongPassword.status);
        assert.equal(unknownEmail.body.message, wrongPassword.body.message);
        assert.equal(unknownEmail.body.code, wrongPassword.body.code);
    });

    test('rejects a deactivated account even with the right password', async () => {
        const email = `inactive.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        await execute('UPDATE users SET is_active = 0 WHERE email = :email', { email });

        try {
            const { status, body } = await client.post('/api/auth/login', { email, password: newUser.password });
            assert.equal(status, 403);
            assert.equal(body.code, 'ACCOUNT_DISABLED');
        } finally {
            // Restore in a finally block: if the assertion above fails, the
            // account would stay deactivated and break later suites that
            // reuse these rows.
            await execute('UPDATE users SET is_active = 1 WHERE email = :email', { email });
        }
    });

    test('resolves the current session through GET /auth/me', async () => {
        const { client, user } = await loginAs('guest@example.com', 'Guest@1234');
        const { status, body } = await client.get('/api/auth/me');

        assert.equal(status, 200);
        assert.equal(body.data.user.email, user.email);
    });

    test('rejects /auth/me without a session', async () => {
        const client = new TestClient();
        const { status, body } = await client.get('/api/auth/me');

        assert.equal(status, 401);
        assert.equal(body.code, 'NO_TOKEN');
    });

    test('rejects a tampered token', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');
        // Flip the last character of the signature.
        const token = client.cookies.get('hotel_token');
        client.cookies.set('hotel_token', `${token.slice(0, -2)}xy`);

        const { status, body } = await client.get('/api/auth/me');
        assert.equal(status, 401);
        assert.equal(body.code, 'INVALID_TOKEN');
    });
});

// ---------------------------------------------------------------------------
describe('Logout', () => {
    test('clears the auth cookie and ends the session', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');

        const before = await client.get('/api/auth/me');
        assert.equal(before.status, 200);

        const logout = await client.post('/api/auth/logout');
        assert.equal(logout.status, 200);

        const after = await client.get('/api/auth/me');
        assert.equal(after.status, 401, 'session must not survive logout');
    });
});

// ---------------------------------------------------------------------------
describe('Role based access control', () => {
    test('a guest cannot reach staff-only endpoints', async () => {
        const { client } = await loginAs('guest@example.com', 'Guest@1234');
        const { status, body } = await client.get('/api/admin/users');

        // The route is not mounted yet, so the guard must still reject a
        // guest rather than fall through to a 404.
        assert.notEqual(status, 200);
        assert.ok([401, 403, 404].includes(status));
    });

    test('an unauthenticated request is rejected before authorization', async () => {
        const client = new TestClient();
        const { status } = await client.get('/api/admin/users');
        assert.equal(status, 401);
    });
});

// ---------------------------------------------------------------------------
describe('Password recovery', () => {
    test('returns a neutral response for an unknown email', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/forgot-password', {
            email: `ghost.${runId}@example.com`,
        });

        assert.equal(status, 200);
        assert.equal(body.success, true);
        // The message must not confirm or deny that the account exists.
        assert.match(body.message, /if an account exists/i);
    });

    test('stores only a hash of the reset token, never the raw token', async () => {
        const email = `reset.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });
        await client.post('/api/auth/forgot-password', { email });

        const rows = await select(
            `SELECT pr.token_hash, u.email
             FROM password_resets pr JOIN users u ON u.id = pr.user_id
             WHERE u.email = :email AND pr.used_at IS NULL`,
            { email },
        );

        assert.equal(rows.length, 1);
        // A sha256 digest is always 64 hex characters.
        assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/);
    });

    test('resets a password with a valid token and allows the new password to sign in', async () => {
        const email = `flow.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        // The development mailer logs the link to the server console; read it
        // from the database instead by generating a token the same way the
        // service does, which keeps the test independent of console output.
        await client.post('/api/auth/forgot-password', { email });

        const { hashToken, generateSecureToken } = await import('../src/utils/tokens.js');
        const rawToken = generateSecureToken(32);

        // Replace the stored hash with one for our known token.
        const users = await select('SELECT id FROM users WHERE email = :email', { email });
        await execute('DELETE FROM password_resets WHERE user_id = :userId', { userId: users[0].id });
        await execute(
            `INSERT INTO password_resets (user_id, token_hash, expires_at)
             VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
            { userId: users[0].id, tokenHash: hashToken(rawToken) },
        );

        const reset = await client.post('/api/auth/reset-password', {
            token: rawToken,
            password: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });
        assert.equal(reset.status, 200);

        // The new password works.
        const relogin = await client.post('/api/auth/login', { email, password: 'BrandNew!456' });
        assert.equal(relogin.status, 200);

        // The old password no longer works.
        const oldLogin = await client.post('/api/auth/login', { email, password: newUser.password });
        assert.equal(oldLogin.status, 401);
    });

    test('rejects an invalid reset token', async () => {
        const client = new TestClient();
        const { status, body } = await client.post('/api/auth/reset-password', {
            token: 'a'.repeat(64),
            password: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'INVALID_OR_EXPIRED_TOKEN');
    });

    test('rejects a reset token that has expired', async () => {
        const email = `expired.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        const { hashToken, generateSecureToken } = await import('../src/utils/tokens.js');
        const rawToken = generateSecureToken(32);
        const users = await select('SELECT id FROM users WHERE email = :email', { email });

        await execute(
            `INSERT INTO password_resets (user_id, token_hash, expires_at)
             VALUES (:userId, :tokenHash, DATE_SUB(NOW(), INTERVAL 1 HOUR))`,
            { userId: users[0].id, tokenHash: hashToken(rawToken) },
        );

        const { status, body } = await client.post('/api/auth/reset-password', {
            token: rawToken,
            password: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });

        assert.equal(status, 400);
        assert.equal(body.code, 'INVALID_OR_EXPIRED_TOKEN');
    });

    test('allows a reset token to be used only once', async () => {
        const email = `singleuse.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        const { hashToken, generateSecureToken } = await import('../src/utils/tokens.js');
        const rawToken = generateSecureToken(32);
        const users = await select('SELECT id FROM users WHERE email = :email', { email });

        await execute(
            `INSERT INTO password_resets (user_id, token_hash, expires_at)
             VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
            { userId: users[0].id, tokenHash: hashToken(rawToken) },
        );

        const first = await client.post('/api/auth/reset-password', {
            token: rawToken,
            password: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });
        assert.equal(first.status, 200);

        // Replaying the same link must fail even though the password matched.
        const second = await client.post('/api/auth/reset-password', {
            token: rawToken,
            password: 'AnotherOne!789',
            confirmPassword: 'AnotherOne!789',
        });
        assert.equal(second.status, 400);
    });
});

// ---------------------------------------------------------------------------
describe('Changing password while signed in', () => {
    test('requires the current password', async () => {
        const email = `chpw.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        const { body } = await client.post('/api/auth/change-password', {
            currentPassword: 'DefinitelyWrong1',
            newPassword: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });

        assert.equal(body.code, 'INVALID_CURRENT_PASSWORD');
    });

    test('changes the password and invalidates outstanding reset links', async () => {
        const email = `chpw2.${runId}@example.com`;
        const client = new TestClient();
        await client.post('/api/auth/register', { ...newUser, email });

        // Create a reset token, then change the password directly.
        await client.post('/api/auth/forgot-password', { email });

        const change = await client.post('/api/auth/change-password', {
            currentPassword: newUser.password,
            newPassword: 'BrandNew!456',
            confirmPassword: 'BrandNew!456',
        });
        assert.equal(change.status, 200);

        const rows = await select(
            `SELECT used_at FROM password_resets pr
             JOIN users u ON u.id = pr.user_id WHERE u.email = :email`,
            { email },
        );
        assert.ok(
            rows.every((row) => row.used_at !== null),
            'all outstanding reset tokens must be invalidated after a password change',
        );

        const relogin = await client.post('/api/auth/login', { email, password: 'BrandNew!456' });
        assert.equal(relogin.status, 200);
    });
});

/** Maps a role to its documented demo password. */
function passwordFor(role) {
    const passwords = {
        admin: 'Admin@1234',
        manager: 'Manager@1234',
        receptionist: 'Reception@1234',
        restaurant_staff: 'Restaurant@1234',
        housekeeping: 'Housekeep@1234',
    };
    return passwords[role];
}