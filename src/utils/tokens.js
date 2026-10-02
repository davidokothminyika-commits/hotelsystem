/**
 * src/utils/tokens.js
 *
 * WHAT THIS MODULE DOES
 * Generates cryptographically secure tokens and signs/verifies JWTs.
 *
 * WHY IT EXISTS
 * Security-critical code should live in exactly one file. Password reset and
 * email verification both need "a secret I can store only as a hash", and
 * every authenticated request needs "a token I can verify". Keeping both here
 * means the rules (token length, hashing algorithm, JWT payload) are defined
 * once and reused.
 *
 * COMMUNICATION
 * Used by: services/auth.service.js, middleware/auth.middleware.js.
 * Reads: config/env.js for the JWT secret and expiry.
 * Database tables used: none (hash/compare helpers are pure functions).
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';

/**
 * Creates a random token for password resets and email verification.
 *
 * `crypto.randomBytes(32)` produces 256 bits of entropy from the OS CSPRNG,
 * which is the same quality used for TLS keys. We return hex so the token is
 * safe to place in a URL without percent-encoding.
 *
 * @returns {string} 64 character hex string
 */
export function generateSecureToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hashes a token before it is written to the database.
 *
 * WHY HASH THE RESET TOKEN
 * The raw token is emailed to the user, so it travels through an email inbox
 * that the hotel does not control. If the database were ever leaked, an
 * attacker with only the stored hashes could not use them: they would have to
 * reverse the SHA-256 hash, which is not computationally feasible.
 *
 * SHA-256 is the right choice here (not bcrypt) because the input already has
 * 256 bits of entropy, so there is nothing for an attacker to brute force, and
 * lookups need to stay fast and constant length.
 *
 * @param {string} token
 * @returns {string} 64 character hex digest
 */
export function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * Plain `===` returns as soon as two characters differ, which leaks a little
 * information about how much of a secret was guessed correctly. `timingSafeEqual`
 * always compares every byte.
 *
 * @param {string} a
 * @param {string} b
 */
export function safeCompare(a, b) {
    const bufferA = Buffer.from(String(a));
    const bufferB = Buffer.from(String(b));
    // timingSafeEqual throws if lengths differ, so reject that first.
    if (bufferA.length !== bufferB.length) return false;
    return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Signs a JWT carrying the user id, role and email.
 *
 * @param {{ id: number, role: string, email: string }} user
 * @returns {string} signed JWT
 */
export function signAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user.id),
            id: user.id,
            role: user.role,
            email: user.email,
        },
        env.jwt.secret,
        { expiresIn: env.jwt.expiresIn },
    );
}

/**
 * Verifies a JWT and returns its payload.
 *
 * @param {string} token
 * @returns {object} decoded payload
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyAccessToken(token) {
    return jwt.verify(token, env.jwt.secret);
}

export default {
    generateSecureToken,
    hashToken,
    safeCompare,
    signAccessToken,
    verifyAccessToken,
};