/**
 * src/repositories/token.repository.js
 *
 * WHAT THIS MODULE DOES
 * Stores and validates password reset and email verification tokens.
 *
 * WHY IT EXISTS
 * Both token flows need identical guarantees (hash only, single use, expiring)
 * and must enforce them in SQL rather than in JavaScript, so the checks cannot
 * be bypassed by a second concurrent request.
 *
 * COMMUNICATION
 * Called by: services/auth.service.js.
 * Database tables used: password_resets, email_verification_tokens.
 */
import { query, execute } from '../config/db.js';

const tokenRepository = {
    /**
     * Stores a new reset request.
     *
     * Any earlier unused token for this user is marked used in the same
     * statement, so requesting a new link always invalidates the old one.
     */
    async createPasswordReset({ userId, tokenHash, expiresAt }) {
        await execute(
            `UPDATE password_resets SET used_at = NOW()
             WHERE user_id = :userId AND used_at IS NULL`,
            { userId },
        );

        await execute(
            `INSERT INTO password_resets (user_id, token_hash, expires_at)
             VALUES (:userId, :tokenHash, :expiresAt)`,
            { userId, tokenHash, expiresAt },
        );
    },

    /**
     * Finds a reset token that is genuinely usable.
     *
     * All three conditions are enforced together in one query, so a token
     * cannot pass validation and then be consumed twice.
     */
    async findValidPasswordReset(tokenHash) {
        const rows = await query(
            `SELECT id, user_id, expires_at
             FROM password_resets
             WHERE token_hash = :tokenHash
               AND used_at IS NULL
               AND expires_at > NOW()
             LIMIT 1`,
            { tokenHash },
        );
        return rows.length ? rows[0] : null;
    },

    async markPasswordResetUsed(id) {
        await execute('UPDATE password_resets SET used_at = NOW() WHERE id = :id', { id });
    },

    /** Invalidates every outstanding reset token, e.g. after a password change. */
    async invalidateAllPasswordResets(userId) {
        await execute(
            'UPDATE password_resets SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL',
            { userId },
        );
    },

    // ------------------------------------------------------------------------
    // EMAIL VERIFICATION (identical guarantees)
    // ------------------------------------------------------------------------

    async createEmailVerification({ userId, tokenHash, expiresAt }) {
        await execute(
            `UPDATE email_verification_tokens SET used_at = NOW()
             WHERE user_id = :userId AND used_at IS NULL`,
            { userId },
        );

        await execute(
            `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
             VALUES (:userId, :tokenHash, :expiresAt)`,
            { userId, tokenHash, expiresAt },
        );
    },

    async findValidEmailVerification(tokenHash) {
        const rows = await query(
            `SELECT id, user_id, expires_at
             FROM email_verification_tokens
             WHERE token_hash = :tokenHash
               AND used_at IS NULL
               AND expires_at > NOW()
             LIMIT 1`,
            { tokenHash },
        );
        return rows.length ? rows[0] : null;
    },

    async markEmailVerificationUsed(id) {
        await execute('UPDATE email_verification_tokens SET used_at = NOW() WHERE id = :id', { id });
    },

    async invalidateAllEmailVerifications(userId) {
        await execute(
            `UPDATE email_verification_tokens SET used_at = NOW()
             WHERE user_id = :userId AND used_at IS NULL`,
            { userId },
        );
    },

    /** Housekeeping: removes consumed and expired rows so the tables stay small. */
    async purgeExpired() {
        const resets = await execute('DELETE FROM password_resets WHERE expires_at < NOW()');
        const verifications = await execute('DELETE FROM email_verification_tokens WHERE expires_at < NOW()');
        return { resets: resets.affectedRows, verifications: verifications.affectedRows };
    },
};

export default tokenRepository;