/**
 * scripts/apply-schema.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Applies `database/schema.sql` to the configured database, then adds any
 * column, index or foreign key that a database created by an older version of
 * the schema is missing.
 *
 * WHY IT EXISTS
 * The project has no migration framework, and `CREATE TABLE IF NOT EXISTS`
 * silently skips a table that already exists - which is right for a fresh
 * install but means an existing database never gains the columns added to that
 * table's definition later. This script closes that gap for the two cases the
 * schema has already hit (bookings.group_id) while staying a no-op everywhere
 * else, so it can be run on every checkout: fresh, current or one version old.
 *
 * Every statement is either `IF NOT EXISTS` or guarded by an
 * information_schema lookup first, so running it twice is safe and running it
 * never overwrites data.
 *
 * RUN
 *   npm run db:schema
 *   node scripts/apply-schema.mjs
 *
 * COMMUNICATION
 * Reads: database/schema.sql, src/config/env.js (via .env)
 * Writes: every table in the schema; nothing outside the database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import env from '../src/config/env.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const connection = await mysql.createConnection({
    ...env.db,
    // The schema file is one script: SET NAMES, comments, CREATE TABLEs and a
    // seed INSERT. Splitting it on ';' here would break on any statement that
    // ever contains a semicolon in a string, so the server parses it whole.
    multipleStatements: true,
    // NOT namedPlaceholders: the schema script is raw SQL and mysql2 would
    // scan it for :name tokens (there are colons in comments and JSON
    // examples), then fail looking for a parameter object that cannot exist.
    // The guarded ALTERs below use positional `?` markers.
    dateStrings: true,
});

async function columnExists(table, column) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS total FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column],
    );
    return Number(rows[0].total) > 0;
}

async function indexExists(table, indexName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS total FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, indexName],
    );
    return Number(rows[0].total) > 0;
}

async function constraintExists(constraintName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS total FROM information_schema.table_constraints
          WHERE table_schema = DATABASE() AND constraint_name = ?`,
        [constraintName],
    );
    return Number(rows[0].total) > 0;
}

/**
 * Applies one conditional DDL step, logging only when it actually changes
 * something. The log is what tells an operator whether their database was
 * behind, rather than a wall of "already exists" noise.
 */
async function ensure(label, check, apply) {
    if (await check()) return;
    await apply();
    console.log(`  + ${label}`);
}

async function main() {
    console.log(`Applying database/schema.sql to ${env.db.database} at ${env.db.host}:${env.db.port}...`);

    const schema = readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
    await connection.query(schema);
    console.log('  + schema.sql executed');

    // --- Additions to tables that already exist in older databases ----------
    // CREATE TABLE IF NOT EXISTS cannot alter them, so each addition that has
    // been made to an existing table's definition is replayed here. Keep this
    // list in step with database/schema.sql: a column added there to an
    // existing table needs an entry here too.

    await ensure(
        'bookings.group_id column',
        () => columnExists('bookings', 'group_id'),
        () => connection.query(
            `ALTER TABLE bookings ADD COLUMN group_id BIGINT UNSIGNED NULL AFTER created_by`,
        ),
    );

    await ensure(
        'bookings.ix_bookings_group index',
        () => indexExists('bookings', 'ix_bookings_group'),
        () => connection.query(`ALTER TABLE bookings ADD KEY ix_bookings_group (group_id)`),
    );

    await ensure(
        'bookings.fk_bookings_group constraint',
        () => constraintExists('fk_bookings_group'),
        () => connection.query(
            `ALTER TABLE bookings ADD CONSTRAINT fk_bookings_group
             FOREIGN KEY (group_id) REFERENCES booking_groups (id) ON DELETE SET NULL`,
        ),
    );

    console.log('Schema is up to date.');
}

main()
    .finally(async () => {
        await connection.end();
    })
    .catch(async (error) => {
        console.error('\nSchema update failed:', error.message);
        process.exitCode = 1;
    });
