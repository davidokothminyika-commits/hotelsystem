/**
 * src/services/settings.service.js
 *
 * WHAT THIS MODULE DOES
 * Reads and updates the system's branding: the hotel name, the small line
 * under the wordmark, the logo and the public contact details. This is what
 * an administrator edits on the admin Settings screen.
 *
 * WHY IT IS NOT JUST AN ENVIRONMENT VARIABLE
 * APP_NAME in .env is the deployment default and cannot change without a
 * restart and an edit to a file that must never be served to the browser.
 * Branding is hotel data: the front desk should be able to correct a spelling
 * or replace the logo without a developer.
 *
 * WHY READS NEVER FAIL THE PAGE
 * Every page loads the header, and the header shows the wordmark. If the
 * settings read threw, the whole site would be blank. So a missing table or a
 * database hiccup falls back to DEFAULT_BRANDING, which is the same text the
 * markup shipped with before this feature existed.
 *
 * WHY EXACTLY ONE LOGO SOURCE IS EVER SET
 * An uploaded file (logo_path) and an external URL (logo_url) are two ways to
 * answer the same question, so only one is kept. Setting either clears the
 * other, which means there is never a stale file on disk that the UI can no
 * longer reach, and no ambiguity about which logo is live.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> repositories/settings.repository.js -> MySQL
 * Frontend: public/js/components/branding.js
 * Database tables used: system_settings.
 */
import path from 'node:path';
import fs from 'node:fs';
import settingsRepository from '../repositories/settings.repository.js';
import { UPLOAD_ROOT, deleteUploadedFile } from '../middleware/upload.middleware.js';
import ApiError from '../utils/errors.js';

/**
 * What the site looked like before branding was configurable. Used as the
 * fallback whenever the stored row cannot be read.
 */
export const DEFAULT_BRANDING = Object.freeze({
    systemName: 'Aurelia Grand Hotel',
    tagline: 'Nairobi, Kenya',
    contactPhone: '+254 700 000 000',
    contactEmail: 'reservations@example.com',
    contactAddress: '24 Riverside Drive, Nairobi, Kenya',
    logoUrl: null,
    logoPath: null,
});

/** Where an uploaded logo is streamed from. Must match the public route. */
const LOGO_ROUTE = '/api/settings/logo';

/**
 * Maps a database row to the shape the frontend uses.
 * @param {object|null} row
 */
function toBranding(row) {
    if (!row) return { ...DEFAULT_BRANDING };

    return {
        systemName: row.system_name || DEFAULT_BRANDING.systemName,
        tagline: row.tagline || '',
        contactPhone: row.contact_phone || '',
        contactEmail: row.contact_email || '',
        contactAddress: row.contact_address || '',
        // An uploaded file wins over a URL, because it is what was set last.
        logoPath: row.logo_path || null,
        logoUrl: row.logo_path ? LOGO_ROUTE : row.logo_url || null,
    };
}

/**
 * Accepts only absolute http(s) URLs.
 *
 * The value is written straight into an `src` attribute by the frontend, so
 * `javascript:` and `data:` must never survive validation. Anything that is
 * not plainly http(s) is treated as "no logo given" rather than an error, so
 * a mistyped URL degrades to the default icon instead of breaking the header.
 */
function isUsableUrl(value) {
    if (!value) return false;
    try {
        const { protocol } = new URL(String(value));
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

const settingsService = {
    /**
     * The branding for every visitor. Never throws: a read failure returns the
     * defaults so the page still renders.
     */
    async getBranding() {
        try {
            return toBranding(await settingsRepository.find());
        } catch (error) {
            console.error('[settings] Could not read branding, using defaults:', error.message);
            return { ...DEFAULT_BRANDING };
        }
    },

    /**
     * Saves the editable branding fields.
     *
     * `logoUrl` is optional and uses last-write-wins semantics:
     *   - a non-empty http(s) URL replaces any uploaded file (which is deleted)
     *   - an empty string clears the logo entirely, restoring the default icon
     *   - the field being absent leaves the logo untouched
     *
     * @param {object} payload
     * @param {number} userId Administrator making the change.
     * @param {Set<string>} [provided] Field names the client actually sent.
     *   Absent, every field in the payload is treated as sent.
     */
    async updateBranding(payload, userId, provided) {
        const current = await settingsService.getBrandingRecord();

        // Set only when a logo is being replaced, then deleted after the save.
        let supersededLogo = null;

        // Only the columns the caller actually sent are written. This is what
        // makes a partial save partial: sending just the name must not blank the
        // phone number typed last week. `provided` is authoritative because the
        // validators sanitise a missing field into '', which would otherwise be
        // indistinguishable from the administrator clearing it.
        const sent = (field) => (provided ? provided.has(field) : payload[field] !== undefined);
        const fields = {};

        if (sent('systemName')) fields.system_name = payload.systemName;
        if (sent('tagline')) fields.tagline = payload.tagline || null;
        if (sent('contactPhone')) fields.contact_phone = payload.contactPhone || null;
        if (sent('contactEmail')) fields.contact_email = payload.contactEmail || null;
        if (sent('contactAddress')) fields.contact_address = payload.contactAddress || null;

        if (sent('logoUrl')) {
            const replacement = String(payload.logoUrl || '').trim();

            if (replacement && !isUsableUrl(replacement)) {
                throw ApiError.badRequest(
                    'The logo URL must start with http:// or https://',
                    'INVALID_LOGO_URL',
                );
            }

            // The superseded upload is removed only after the row is saved, so a
            // failed update cannot leave the site pointing at a deleted file.
            supersededLogo = current?.logo_path || null;

            fields.logo_url = replacement || null;
            fields.logo_path = null;
        }

        const saved = toBranding(await settingsRepository.update(fields, userId ?? null));

        if (supersededLogo) deleteUploadedFile(supersededLogo);

        return saved;
    },

    /**
     * Stores a freshly uploaded logo, replacing whatever was there.
     * @param {string} storedPath e.g. 'hotel/abc123.png'
     * @param {number} userId
     */
    async setLogo(storedPath, userId) {
        const current = await settingsService.getBrandingRecord();

        // Only delete after the new row is safely written, so a failed update
        // cannot leave the site with no logo and no file to restore.
        const saved = toBranding(await settingsRepository.update({ logo_path: storedPath, logo_url: null }, userId ?? null));

        if (current.logo_path && current.logo_path !== storedPath) {
            deleteUploadedFile(current.logo_path);
        }

        return saved;
    },

    /**
     * Resolves the stored upload to an absolute path on disk, or null when no
     * file has been uploaded.
     *
     * The containment check matters: the path comes from the database, and
     * this handler streams whatever it is given. Resolving it and confirming
     * it is still inside UPLOAD_ROOT means a tampered row cannot be used to
     * read /etc/passwd.
     */
    async resolveLogoFile() {
        let row;
        try {
            row = await settingsRepository.find();
        } catch (error) {
            console.error('[settings] Could not read the logo path:', error.message);
            return null;
        }

        if (!row?.logo_path) return null;

        const absolute = path.resolve(UPLOAD_ROOT, row.logo_path);
        if (!absolute.startsWith(UPLOAD_ROOT + path.sep)) {
            console.warn(`[settings] Refused to serve a logo outside the upload root: ${row.logo_path}`);
            return null;
        }

        if (!fs.existsSync(absolute)) {
            console.warn(`[settings] Logo file is missing on disk: ${row.logo_path}`);
            return null;
        }

        return absolute;
    },

    /**
     * The raw row, or null. Used internally where the defaults would hide
     * what is actually stored.
     */
    async getBrandingRecord() {
        try {
            const row = await settingsRepository.find();
            if (row) return row;
            return await settingsRepository.createDefaults();
        } catch (error) {
            console.error('[settings] Could not read the settings row:', error.message);
            return null;
        }
    },
};

export default settingsService;
