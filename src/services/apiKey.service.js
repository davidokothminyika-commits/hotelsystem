/**
 * src/services/apiKey.service.js
 *
 * WHAT THIS MODULE DOES
 * Credentials for third-party systems consuming the hotel's open API:
 * issuing, verifying and revoking keys.
 *
 * THE KEY CONTRACT
 *   The full key is generated server-side and shown exactly once, in the
 *   creation response - after that, only its hash exists in the database and
 *   only its prefix is visible. A leaked database therefore cannot be replayed
 *   against the API, and an administrator can still tell their two
 *   integrations apart from the stored prefix.
 *
 * WHY A DEDICATED /api/external SURFACE RATHER THAN COOKIE-SHAPED TOKENS
 * These keys authenticate *systems*, not people, and they must never be able
 * to do anything a staff member could do by mistake. They are verified with a
 * hash comparison per request, carry no scopes beyond read-only data, live
 * outside the session cookie flow, and can be revoked in one second without
 * touching any user account.
 *
 * COMMUNICATION
 * Called by: middleware/apiKeyAuth.middleware.js, integration.controller.js
 * Database tables used: api_keys, users
 */
import crypto from 'node:crypto';
import { query, queryOne, execute } from '../config/db.js';

/** Shape of a visible key prefix, documented for callers and tests. */
const KEY_PREFIX_PATTERN = /^hk_[0-9a-f]{8}$/;

const apiKeyService = {
    /**
     * Issues one key.
     *
     * The prefix is random so it doubles as part of the secret. A collision at
     * the unique key_prefix column retries rather than surfacing as a 500.
     *
     * @returns {{ apiKey: object, key: string }} `key` is the only time the
     * full credential ever exists outside the client's clipboard.
     */
    async createKey({ name }, requester) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const prefix = `hk_${crypto.randomBytes(4).toString('hex')}`.slice(0, 10);
            const remainder = crypto.randomBytes(16).toString('hex');
            const fullKey = `${prefix}${remainder}`;

            try {
                const result = await execute(
                    `INSERT INTO api_keys (name, key_prefix, key_hash, created_by)
                     VALUES (:name, :prefix, :hash, :createdBy)`,
                    {
                        name,
                        prefix,
                        hash: this.hash(fullKey),
                        createdBy: requester.id,
                    },
                );

                return {
                    apiKey: await this.getKey(result.insertId),
                    key: fullKey,
                };
            } catch (error) {
                // ER_DUP_ENTRY on key_prefix: regenerate. Anything else is real.
                if (attempt === 4 || error.code !== 'ER_DUP_ENTRY') throw error;
            }
        }

        throw new Error('Unable to generate a unique API key');
    },

    hash(fullKey) {
        // SHA-256, exactly as the password resets table does for its tokens:
        // fast enough to verify per request, still preimage-resistant enough
        // that a 128-bit random key cannot be recovered from its hash.
        return crypto.createHash('sha256').update(fullKey).digest('hex');
    },

    /**
     * Verifies a presented key. Returns the stored row (never the full key,
     * which does not exist here) or null when the key is unknown, inactive or
     * revoked.
     */
    async verify(presentedKey) {
        if (typeof presentedKey !== 'string' || !presentedKey.startsWith('hk_')) return null;

        const row = await queryOne(
            `SELECT id, name, key_prefix, is_active, revoked_at, last_used_at
             FROM api_keys
             WHERE key_hash = :hash
               AND is_active = 1
               AND revoked_at IS NULL`,
            { hash: this.hash(presentedKey) },
        );

        if (!row) return null;

        // Last-used bookkeeping is a single cheap write that gives the admin
        // screen a real signal about which integrations are still alive.
        await execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = :id', { id: row.id });

        return {
            id: row.id,
            name: row.name,
            keyPrefix: row.key_prefix,
            lastUsedAt: new Date().toISOString(),
        };
    },

    async getKey(id) {
        const row = await queryOne(
            `SELECT k.id, k.name, k.key_prefix, k.is_active, k.last_used_at, k.created_by,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    k.revoked_at, k.created_at
             FROM api_keys k
             LEFT JOIN users u ON u.id = k.created_by
             WHERE k.id = :id`,
            { id },
        );
        if (!row) return null;
        return this.mapKey(row);
    },

    mapKey(row) {
        return {
            id: row.id,
            name: row.name,
            keyPrefix: row.key_prefix,
            isActive: Number(row.is_active) === 1,
            lastUsedAt: row.last_used_at,
            createdBy: row.created_by,
            createdByName: row.created_by_name || null,
            revokedAt: row.revoked_at,
            createdAt: row.created_at,
        };
    },

    async listKeys() {
        const rows = await query(
            `SELECT k.id, k.name, k.key_prefix, k.is_active, k.last_used_at, k.created_by,
                    CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
                    k.revoked_at, k.created_at
             FROM api_keys k
             LEFT JOIN users u ON u.id = k.created_by
             ORDER BY k.created_at DESC`,
        );
        return rows.map((row) => this.mapKey(row));
    },

    /** Revokes in the sense the schema supports: deactivate + stamp the time. */
    async revoke(id) {
        await execute(
            'UPDATE api_keys SET is_active = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE id = :id',
            { id },
        );
        return this.getKey(id);
    },
};

export { KEY_PREFIX_PATTERN };
export default apiKeyService;
