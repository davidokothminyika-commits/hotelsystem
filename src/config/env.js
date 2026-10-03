/**
 * src/config/env.js
 *
 * WHAT THIS MODULE DOES
 * Loads `.env` into process.env, then validates the configuration and
 * exports one frozen object (`env`) that every other module reads from.
 *
 * WHY IT EXISTS
 * Application code should never read `process.env` directly. Routing all
 * configuration through a single validated module means a missing or invalid
 * value fails once at boot with a clear message, instead of failing later
 * with a confusing `undefined`.
 *
 * COMMUNICATION
 * Used by: db.js, server.js, mailer.js, and any module needing secrets or URLs.
 * Reads: nothing but the `.env` file and process.env.
 * Database tables used: none (pure configuration).
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// `src/config` -> project root
export const ROOT_DIR = path.resolve(currentDir, '..', '..');

// Load .env from the project root. A missing file is fine because the
// values may come from real environment variables (Docker, CI, hosting).
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/**
 * Reads a variable and falls back to a development default.
 * Keeping defaults here means `npm run dev` works on a clean clone.
 */
function read(key, fallback) {
    const value = process.env[key];
    if (value === undefined || value === '') return fallback;
    return value;
}

/**
 * Same as `read`, but an explicitly empty value is preserved instead of
 * falling back. Needed for DB_USER: some local MySQL setups allow anonymous
 * or password-less access, where the username is genuinely the empty string.
 */
function readAllowEmpty(key, fallback) {
    const value = process.env[key];
    if (value === undefined) return fallback;
    return value;
}

function readInt(key, fallback) {
    const parsed = Number.parseInt(read(key, ''), 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function readBool(key, fallback) {
    const raw = read(key, '');
    if (raw === '') return fallback;
    return raw === 'true' || raw === '1';
}

const nodeEnv = read('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

/**
 * In development we fall back to an obviously-insecure secret so a fresh
 * clone boots without setup. In production a real secret is mandatory,
 * because signing JWTs with a public default would let anyone forge tokens.
 */
function resolveSecret(value, devFallback, label) {
    const secret = read(value.key, '');
    if (secret) return secret;

    if (isProduction) {
        throw new Error(
            `[config] ${label} is required in production. Set ${value.key} in your .env file.`,
        );
    }

    console.warn(
        `[config] WARNING: ${value.key} is not set. Using an insecure development default.`,
    );
    return devFallback;
}

export const env = Object.freeze({
    nodeEnv,
    isProduction,
    isDevelopment: !isProduction,
    port: readInt('PORT', 5000),
    appUrl: read('APP_URL', 'http://localhost:5000'),
    appName: read('APP_NAME', 'Aurelia Grand Hotel'),

    // Selects the payment provider. Kept as configuration so a real gateway
    // is a .env change rather than a code change.
    paymentProvider: read('PAYMENT_PROVIDER', 'mock'),

    db: Object.freeze({
        host: read('DB_HOST', 'localhost'),
        port: readInt('DB_PORT', 3306),
        database: read('DB_NAME', 'test_hotel_system'),
        // Preserves DB_USER= (anonymous login) when set to an empty string.
        user: readAllowEmpty('DB_USER', 'root'),
        password: readAllowEmpty('DB_PASSWORD', ''),
        connectionLimit: readInt('DB_CONNECTION_LIMIT', 10),
    }),

    jwt: Object.freeze({
        secret: resolveSecret(
            { key: 'JWT_SECRET' },
            'dev-only-insecure-jwt-secret-do-not-use-in-production',
            'JWT_SECRET',
        ),
        expiresIn: read('JWT_EXPIRES_IN', '1d'),
    }),

    cookieSecret: resolveSecret(
        { key: 'COOKIE_SECRET' },
        'dev-only-insecure-cookie-secret',
        'COOKIE_SECRET',
    ),

    tokens: Object.freeze({
        passwordResetExpiryMinutes: readInt('PASSWORD_RESET_EXPIRY_MINUTES', 60),
        emailVerificationExpiryMinutes: readInt('EMAIL_VERIFICATION_EXPIRY_MINUTES', 1440),
    }),

    mail: Object.freeze({
        enabled: readBool('MAIL_ENABLED', false),
        host: read('MAIL_HOST', ''),
        port: readInt('MAIL_PORT', 587),
        secure: readBool('MAIL_SECURE', false),
        user: read('MAIL_USER', ''),
        password: read('MAIL_PASSWORD', ''),
        fromName: read('MAIL_FROM_NAME', 'Aurelia Grand Hotel'),
        fromAddress: read('MAIL_FROM_ADDRESS', 'no-reply@example.com'),
    }),

    uploads: Object.freeze({
        directory: read('UPLOAD_DIR', 'uploads'),
        maxSizeMb: readInt('MAX_UPLOAD_SIZE_MB', 5),
    }),

    rateLimit: Object.freeze({
        windowMinutes: readInt('RATE_LIMIT_WINDOW_MINUTES', 15),
        max: readInt('RATE_LIMIT_MAX', 300),
        authMax: readInt('AUTH_RATE_LIMIT_MAX', 20),
    }),

    isTest: nodeEnv === 'test',
});

export default env;