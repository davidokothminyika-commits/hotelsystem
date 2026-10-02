/**
 * src/routes/auth.routes.js
 *
 * WHAT THIS MODULE DOES
 * Declares every authentication endpoint and the middleware chain that
 * protects it.
 *
 * WHY IT EXISTS
 * A route file should read as a table of contents for a feature. Seeing
 * `requireAuth` and `authLimiter` in one line tells the whole security story
 * without opening the controller.
 *
 * MIDDLEWARE ORDER MATTERS
 *   authLimiter -> validate -> controller
 * The limiter runs first so a flood of malformed requests is rejected before
 * spending time validating them.
 *
 * COMMUNICATION
 * Frontend (public/js/api/auth.js) -> THIS FILE -> auth.controller.js
 * Database tables used: none directly.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter, emailLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import {
    registerRules,
    loginRules,
    forgotPasswordRules,
    resetPasswordRules,
    resetTokenRules,
    verifyEmailRules,
    changePasswordRules,
} from '../validators/auth.validators.js';
import authController from '../controllers/auth.controller.js';

const router = Router();

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

router.post(
    '/register',
    authLimiter,
    validate(registerRules),
    authController.register,
);

router.post(
    '/login',
    authLimiter,
    validate(loginRules),
    authController.login,
);

router.post(
    '/logout',
    // No authLimiter here: signing out must always be possible, even if the
    // login limit has been reached.
    authController.logout,
);

// Lets the frontend resolve the current session on page load.
router.get('/me', requireAuth, authController.me);

// ---------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------

router.post(
    '/forgot-password',
    // Two limits: a per-IP ceiling and a stricter one on the endpoint itself.
    authLimiter,
    emailLimiter,
    validate(forgotPasswordRules),
    authController.forgotPassword,
);

router.post(
    '/reset-password',
    authLimiter,
    validate(resetPasswordRules),
    authController.resetPassword,
);

router.post(
    '/verify-reset-token',
    validate(resetTokenRules),
    authController.verifyResetToken,
);

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

router.post(
    '/verify-email',
    validate(verifyEmailRules),
    authController.verifyEmail,
);

router.post(
    '/resend-verification',
    requireAuth,
    emailLimiter,
    authController.resendVerification,
);

// ---------------------------------------------------------------------------
// Authenticated
// ---------------------------------------------------------------------------

router.post(
    '/change-password',
    requireAuth,
    authLimiter,
    validate(changePasswordRules),
    authController.changePassword,
);

export default router;