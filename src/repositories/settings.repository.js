/**
 * src/repositories/settings.repository.js
 *
 * WHAT THIS MODULE DOES
 * Reads and writes the single `system_settings` row: the hotel's name, logo
 * and contact details.
 *
 * WHY IT EXISTS
 * The branding is one record, so it needs no more than a find and an update.
 * Keeping those two statements here rather than inline in the service means
 * the SQL for the table lives in exactly one file, like every other table.
 *
 * WHY EVERY WRITE TARGETS id = 1
 * The table holds one row, pinned by a CHECK constraint. `findOrCreateId` is
 * still used before writing so a deployment whose schema predates this table
 * has a row to update rather than failing on an empty result.
 *
 * COMMUNICATION
 * Called by: services/settings.service.js
 * Database tables used: system_settings.
 */
import { query, queryOne, execute } from '../config/db.js';

const COLUMNS = `
    id,
    system_name,
    tagline,
    logo_path,
    logo_url,
    contact_phone,
    contact_email,
    contact_address,
    updated_by,
    updated_at
`;

/**
 * Columns an administrator may change. `id` and `updated_by` are deliberately
 * absent: the row identity is fixed, and `updated_by` is set by the service
 * from the authenticated user rather than trusted from the request body.
 */
const WRITABLE_COLUMNS = [
    'system_name',
    'tagline',
    'logo_path',
    'logo_url',
    'contact_phone',
    'contact_email',
    'contact_address',
];

const settingsRepository = {
    /** The settings row, or null when it has never been seeded. */
    async find() {
        return queryOne(`SELECT ${COLUMNS} FROM system_settings WHERE id = 1`);
    },

    /**
     * Creates the row with its defaults if it is missing.
     * Used before an update so saving works on a database where the INSERT in
     * schema.sql never ran, instead of silently updating zero rows.
     */
    async createDefaults() {
        await execute(
            `INSERT IGNORE INTO system_settings (id, system_name) VALUES (1, 'Aurelia Grand Hotel')`,
        );
        return this.find();
    },

    /**
     * Updates the row. Only the columns present in `fields` are written, so a
     * partial update (the logo endpoint) leaves everything else untouched.
     *
     * @param {object} fields   Column/value pairs.
     * @param {number|null} updatedBy  Administrator making the change.
     */
    async update(fields, updatedBy = null) {
        const entries = WRITABLE_COLUMNS.filter((column) => Object.hasOwn(fields, column));
        if (entries.length === 0) return this.find();

        const setClause = entries.map((column) => `${column} = :${column}`).join(', ');

        await execute(
            `UPDATE system_settings SET ${setClause}, updated_by = :updatedBy WHERE id = 1`,
            Object.assign({}, ...entries.map((column) => ({ [column]: fields[column] ?? null })), {
                updatedBy,
            }),
        );

        return this.find();
    },
};

export default settingsRepository;
