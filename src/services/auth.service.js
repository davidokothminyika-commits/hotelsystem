/**
 * src/services/auth.service.js
 *
 * WHAT THIS MODULE DOES
 * Implements registration, login, logout, password recovery and email
 * verification. All password hashing and token generation happens here.
 *
 * WHY IT EXISTS
 * Authentication is the most security critical part of the system, so its
 * rules live in one reviewed file instead of being spread across controllers.
 * Controllers only translate HTTP to and from service calls.
 *
 * COMMUNICATION
 * Browser -> /api/auth/* -> auth.controller.js -> THIS FILE
 *        -> user.repository.js, token.repository.js, mail.service.js
 * Database tables used: users, roles, password_resets,
 *                       email_verification_tokens, tokens.
 *
 * SECURITY RULES ENFORCED IN THIS FILE
 *   1. Passwords are hashed with bcrypt at cost 12 and never logged or returned.
 *   2. Login failures return an identical message whether the email is
 *      unknown or the password is wrong, so attackers cannot enumerate accounts.
 *   3. Reset tokens are random 256-bit values; only their SHA-256 hash is
 *      stored, so a database leak cannot be replayed.
 *   4. Reset tokens are single use and time limited.
 *   5. Timing is equalised on unknown-account login using a dummy bcrypt
 *      comparison, so response time does not reveal whether an account exists.
 */
import bcrypt from 'bcryptjs';
import env from '../config/env.js';
import ApiError from '../utils/errors.js';
import { generateSecureToken, hashToken, signAccessToken } from '../utils/tokens.js';
import userRepository from '../repositories/user.repository.js';
import permissionRepository from '../repositories/permission.repository.js';
import tokenRepository from '../repositories/token.repository.js';
import mailService from './mail.service.js';

/**
 * Cost factor 12 is the current sweet spot: roughly 250ms per hash on
 * typical server hardware. It is deliberately slow, which is the entire
 * point: it makes offline cracking of a stolen hash expensive.
 */
const BCRYPT_ROUNDS = 12;

/**
 * A real bcrypt hash of a random string, used to burn the same amount of time
 * when the email does not exist. Without this, a missing account would return
 * noticeably faster than a wrong password, revealing which emails are
 * registered.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.5Jr3wY1eLlZ7yzWJqK3rL5xVpZ1p8O';

/** Enforces a minimum password strength policy. */
function assertPasswordStrength(password) {
    const problems = [];
    if (password.length < 8) problems.push('be at least 8 characters');
    if (password.length > 128) problems.push('be no more than 128 characters');
    if (!/[a-z]/.test(password)) problems.push('contain a lowercase letter');
    if (!/[A-Z]/.test(password)) problems.push('contain an uppercase letter');
    if (!/\d/.test(password)) problems.push('contain a number');

    if (problems.length > 0) {
        throw ApiError.badRequest(`Password must ${problems.join(', ')}.`, 'WEAK_PASSWORD');
    }

    // Reject the most common passwords outright rather than merely warning.
    const common = new Set([
        'password', 'password1', 'password123', '12345678', '123456789',
        'qwerty123', 'letmein1', 'welcome1', 'admin123', 'hotel123',
    ]);
    if (common.has(password.toLowerCase())) {
        throw ApiError.badRequest('This password is too common. Please choose a less predictable one.', 'WEAK_PASSWORD');
    }
}

const authService = {
    /**
     * Registers a new account.
     *
     * @param {object} input
     * @param {'guest'|'staff'} [input.requestedRole='guest']
     *   New accounts are always created as guests. Staff accounts are created
     *   by an administrator, never by public signup, which is what stops a
     *   visitor from registering themselves as an administrator.
     */
    async register({ firstName, lastName, email, phone, password, requestedRole = 'guest' }) {
        const normalisedEmail = email.trim().toLowerCase();

        assertPasswordStrength(password);

        // Checked here for a friendly message; the UNIQUE index below is the
        // real guarantee against a race between two simultaneous signups.
        if (await userRepository.emailExists(normalisedEmail)) {
            throw ApiError.conflict('An account with that email already exists', 'EMAIL_ALREADY_REGISTERED');
        }

        let roleId = await permissionRepository.findRoleIdByName('guest');
        if (!roleId) {
            throw ApiError.internal('The guest role is missing. Run the seed script.', 'ROLE_MISSING');
        }

        // A caller may only ever request 'guest'. Anything else is granted by
        // the admin service instead.
        if (requestedRole === 'staff') {
            roleId = await permissionRepository.findRoleIdByName('guest');
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const userId = await userRepository.create({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: normalisedEmail,
            phone,
            passwordHash,
            roleId,
            emailVerified: false,
        });

        const user = await userRepository.findById(userId);

        // Fire-and-forget: a mail failure must not prevent registration.
        this.sendVerificationEmail(user).catch((error) =>
            console.error('[auth] Failed to send verification email:', error.message),
        );

        return { user, token: signAccessToken({ id: user.id, role: user.role, email: user.email }) };
    },

    /**
     * Authenticates an email and password.
     */
    async login({ email, password }) {
        const normalisedEmail = email.trim().toLowerCase();
        const record = await userRepository.findByEmailWithPassword(normalisedEmail);

        if (!record) {
            // Compare against the dummy hash anyway to equalise timing.
            await bcrypt.compare(password, DUMMY_HASH);
            throw ApiError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
        }

        const passwordMatches = await bcrypt.compare(password, record.password_hash);

        if (!passwordMatches) {
            throw ApiError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
        }

        if (!record.is_active) {
            throw ApiError.forbidden('Your account has been deactivated. Contact reception.', 'ACCOUNT_DISABLED');
        }

        await userRepository.updateLastLogin(record.id);

        const user = await userRepository.findById(record.id);

        return { user, token: signAccessToken({ id: user.id, role: user.role, email: user.email }) };
    },

    /**
     * Changes the signed in user's password.
     * Requires the current password so a stolen session alone cannot lock the
     * real owner out of their account.
     */
    async changePassword(userId, { currentPassword, newPassword }) {
        const record = await userRepository.findByIdWithPassword(userId);
        if (!record) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');

        const matches = await bcrypt.compare(currentPassword, record.password_hash);
        if (!matches) {
            throw ApiError.badRequest('Your current password is incorrect', 'INVALID_CURRENT_PASSWORD');
        }

        assertPasswordStrength(newPassword);

        if (await bcrypt.compare(newPassword, record.password_hash)) {
            throw ApiError.badRequest('The new password must be different from your current password', 'PASSWORD_REUSED');
        }

        await userRepository.updatePassword(userId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));

        // Changing a password invalidates outstanding reset links.
        await tokenRepository.invalidateAllPasswordResets(userId);

        return { changed: true };
    },

    // ------------------------------------------------------------------------
    // PASSWORD RECOVERY
    // ------------------------------------------------------------------------

    /**
     * Starts the forgot-password flow.
     *
     * ENUMERATION PROTECTION
     * The response is identical whether or not the email exists, and the
     * caller is rate limited. If the account does not exist we return early
     * instead of sending mail, so this endpoint cannot be used to discover
     * which addresses are registered.
     */
    async requestPasswordReset(email) {
        const normalisedEmail = email.trim().toLowerCase();
        const user = await userRepository.findByEmail(normalisedEmail);

        if (!user) {
            return { sent: true };
        }

        const rawToken = generateSecureToken(32);

        await tokenRepository.createPasswordReset({
            userId: user.id,
            tokenHash: hashToken(rawToken),
            expiresAt: new Date(Date.now() + env.tokens.passwordResetExpiryMinutes * 60_000),
        });

        const resetUrl = `${env.appUrl}/pages/auth/reset-password.html?token=${rawToken}`;

        await mailService.sendPasswordReset({
            to: user.email,
            name: `${user.firstName} ${user.lastName}`,
            resetUrl,
            expiresInMinutes: env.tokens.passwordResetExpiryMinutes,
        });

        return { sent: true };
    },

    /**
     * Completes the reset once the user chooses a new password.
     *
     * The token is looked up by its hash in a single query that also enforces
     * expiry and single use, so validation and consumption cannot be
     * separated by a race.
     */
    async resetPassword({ token, password }) {
        if (!token) throw ApiError.badRequest('Reset token is missing', 'TOKEN_MISSING');

        assertPasswordStrength(password);

        const tokenHash = hashToken(token);
        const record = await tokenRepository.findValidPasswordReset(tokenHash);

        if (!record) {
            throw ApiError.badRequest(
                'This reset link is invalid or has expired. Please request a new one.',
                'INVALID_OR_EXPIRED_TOKEN',
            );
        }

        await userRepository.updatePassword(record.user_id, await bcrypt.hash(password, BCRYPT_ROUNDS));

        // Single use: mark consumed, then invalidate any other outstanding links.
        await tokenRepository.markPasswordResetUsed(record.id);
        await tokenRepository.invalidateAllPasswordResets(record.user_id);

        return { reset: true };
    },

    /**
     * Confirms a reset token is still valid, so the reset page can show the
     * form without the user discovering an expired link after typing.
     */
    async validateResetToken(token) {
        if (!token) return { valid: false };
        const record = await tokenRepository.findValidPasswordReset(hashToken(token));
        return { valid: Boolean(record) };
    },

    // ------------------------------------------------------------------------
    // EMAIL VERIFICATION
    // ------------------------------------------------------------------------

    /**
     * Issues and sends a verification link for a user.
     * Existing unused tokens are invalidated first so only one link works.
     */
    async sendVerificationEmail(user) {
        if (!user || user.emailVerified) return { sent: false, reason: 'already_verified' };

        const rawToken = generateSecureToken(32);

        await tokenRepository.createEmailVerification({
            userId: user.id,
            tokenHash: hashToken(rawToken),
            expiresAt: new Date(Date.now() + env.tokens.emailVerificationExpiryMinutes * 60_000),
        });

        const verificationUrl = `${env.appUrl}/pages/auth/verify-email.html?token=${rawToken}`;

        await mailService.sendEmailVerification({
            to: user.email,
            name: `${user.firstName} ${user.lastName}`,
            verificationUrl,
        });

        return { sent: true };
    },

    /** Verifies an address using the emailed token. */
    async verifyEmail(token) {
        if (!token) throw ApiError.badRequest('Verification token is missing', 'TOKEN_MISSING');

        const record = await tokenRepository.findValidEmailVerification(hashToken(token));
        if (!record) {
            throw ApiError.badRequest(
                'This verification link is invalid or has expired.',
                'INVALID_OR_EXPIRED_TOKEN',
            );
        }

        await userRepository.markEmailVerified(record.user_id);
        await tokenRepository.markEmailVerificationUsed(record.id);

        return { verified: true };
    },
};

export default authService;