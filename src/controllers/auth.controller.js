/**
 * src/controllers/auth.controller.js
 *
 * WHAT THIS MODULE DOES
 * Translates HTTP requests into auth service calls and writes the response.
 * It contains no business rules and no SQL.
 *
 * WHY IT EXISTS
 * The controller layer keeps HTTP concerns (cookies, status codes, request
 * bodies) out of the service layer, so the same auth logic could be reused by
 * a CLI tool, a WebSocket handler or a background job without dragging along
 * req and res.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/auth.service.js -> repositories -> MySQL
 * Sets the auth cookie on success; clears it on logout.
 * Frontend calls these via public/js/api/auth.js.
 */
import env from '../config/env.js';
import { sendSuccess, sendCreated } from '../utils/response.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit, recordFailedLogin } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import authService from '../services/auth.service.js';

/**
 * Cookie options for the auth token.
 *
 * httpOnly : JavaScript cannot read this, so an XSS bug cannot steal the token.
 * sameSite : 'lax' blocks CSRF from third-party sites while still sending the
 *            cookie on normal top-level navigation back to the site.
 * secure   : HTTPS only. Left off in development because the local server is
 *            plain http and the browser would drop a secure cookie entirely.
 * maxAge   : Matches JWT_EXPIRES_IN so the cookie never outlives its token.
 */
function authCookieOptions() {
    const expiryMs = durationToMs(env.jwt.expiresIn);
    return {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: expiryMs,
    };
}

/**
 * Converts a JWT_EXPIRES_IN style string ('1d', '2h', '30m', '45s') to
 * milliseconds so it can be used as the cookie lifetime.
 */
function durationToMs(value) {
    const match = /^(\d+)\s*([smhd])?$/.exec(String(value).trim());
    if (!match) return 86_400_000; // default to 1 day
    const amount = Number(match[1]);
    const unit = match[2] || 's';
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return amount * multipliers[unit];
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
export const register = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;
    const { user, token } = await authService.register(payload);

    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());

    await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.REGISTER,
        entity: 'users',
        entityId: user.id,
        req,
        metadata: { email: user.email },
    });

    return sendCreated(res, 'Account created successfully. Welcome to ' + env.appName + '.', { user });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
export const login = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;

    try {
        const { user, token } = await authService.login(payload);

        res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());

        await recordAudit({
            userId: user.id,
            action: AUDIT_ACTIONS.LOGIN,
            entity: 'users',
            entityId: user.id,
            req,
        });

        return sendSuccess(res, 'Signed in successfully', { user });
    } catch (error) {
        // Record the attempt so brute force is visible in the audit trail.
        if (error.code === 'INVALID_CREDENTIALS') {
            await recordFailedLogin({ email: payload.email, req, reason: 'invalid_credentials' });
        }
        throw error;
    }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
/**
 * Stateless JWTs cannot be revoked server side without a token blocklist.
 * Clearing the cookie is sufficient here: the token is short lived, it is
 * http-only so script cannot read it, and the logout is audited.
 * If immediate revocation is ever required, the change is to store the token
 * id in a `revoked_tokens` table and check it in requireAuth.
 */
export const logout = asyncHandler(async (req, res) => {
    const userId = req.user?.id;

    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        secure: env.isProduction,
        sameSite: 'lax',
        path: '/',
    });

    if (userId) {
        await recordAudit({
            userId,
            action: AUDIT_ACTIONS.LOGOUT,
            entity: 'users',
            entityId: userId,
            req,
        });
    }

    return sendSuccess(res, 'Signed out successfully');
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
/**
 * Lets the frontend ask "who am I" on page load. This is how the header
 * decides between showing Sign in or My bookings without storing any token
 * in localStorage.
 */
export const me = asyncHandler(async (req, res) => {
    return sendSuccess(res, 'Current session', { user: req.user });
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------------
export const forgotPassword = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;

    const result = await authService.requestPasswordReset(payload.email);

    if (result.sent) {
        await recordAudit({
            userId: null,
            action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
            entity: 'users',
            req,
            metadata: { email: payload.email },
        });
    }

    // The message is identical whether or not the account exists, so this
    // response cannot be used to discover registered addresses.
    return sendSuccess(
        res,
        'If an account exists for that email, a password reset link has been sent.',
        { sent: true },
    );
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------------
export const resetPassword = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;

    await authService.resetPassword({ token: payload.token, password: payload.password });

    await recordAudit({
        userId: null,
        action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
        entity: 'users',
        req,
    });

    return sendSuccess(res, 'Your password has been reset. You can now sign in.');
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-reset-token
// ---------------------------------------------------------------------------
/**
 * Lets the reset page check the link before showing the password form.
 */
export const verifyResetToken = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;
    const result = await authService.validateResetToken(payload.token);
    return sendSuccess(res, result.valid ? 'Reset link is valid' : 'Reset link is invalid or expired', result);
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email
// ---------------------------------------------------------------------------
export const verifyEmail = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;
    await authService.verifyEmail(payload.token);

    await recordAudit({
        userId: null,
        action: AUDIT_ACTIONS.EMAIL_VERIFIED,
        entity: 'users',
        req,
    });

    return sendSuccess(res, 'Your email address has been verified.');
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification
// ---------------------------------------------------------------------------
/**
 * Sends a fresh verification link. Rate limited on the route.
 */
export const resendVerification = asyncHandler(async (req, res) => {
    const user = req.user;

    if (user.emailVerified) {
        return sendSuccess(res, 'Your email address is already verified.');
    }

    await authService.sendVerificationEmail(user);

    return sendSuccess(res, 'Verification email sent. Please check your inbox.');
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
// ---------------------------------------------------------------------------
export const changePassword = asyncHandler(async (req, res) => {
    const payload = req.validated?.body || req.body;

    await authService.changePassword(req.user.id, {
        currentPassword: payload.currentPassword,
        newPassword: payload.newPassword || payload.password,
    });

    await recordAudit({
        userId: req.user.id,
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        entity: 'users',
        entityId: req.user.id,
        req,
    });

    return sendSuccess(res, 'Password changed successfully');
});

export default {
    register,
    login,
    logout,
    me,
    forgotPassword,
    resetPassword,
    verifyResetToken,
    verifyEmail,
    resendVerification,
    changePassword,
};