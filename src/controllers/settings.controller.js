/**
 * src/controllers/settings.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for the hotel's branding: a public read for every page, the
 * public stream for an uploaded logo, and the administrator-only writes.
 *
 * WHY THE READ IS PUBLIC
 * The welcome page, the footer and the sign in page all show the hotel's name
 * before anyone has an account, so there is nothing to protect here. The
 * response holds only public branding: a name, a logo and contact details
 * that are already printed on the website.
 *
 * WHY THE LOGO IS STREAMED RATHER THAN SERVED STATICALLY
 * Uploads live outside the web root so nothing user-supplied can be executed
 * or guessed at by URL. Streaming it through this handler keeps that boundary:
 * the browser asks for a known route, the server decides what bytes to send.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/settings.service.js -> MySQL, uploads/
 * Frontend: public/js/components/branding.js, public/js/pages/admin/settings.js
 */
import { sendSuccess } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import { toStoredPath } from '../middleware/upload.middleware.js';
import settingsService from '../services/settings.service.js';

const settingsController = {
    /** GET /api/settings/branding - public, cached briefly at the edge. */
    getBranding: asyncHandler(async (req, res) => {
        const branding = await settingsService.getBranding();

        // Short shared cache: a saved change should appear on the next page
        // load, not instantly on every visitor's already-open tab.
        res.set('Cache-Control', 'public, max-age=30');

        return sendSuccess(res, 'Branding retrieved', { branding });
    }),

    /**
     * GET /api/settings/logo - the uploaded logo, or 404 when there is none.
     *
     * The frontend falls back to its built-in icon when this 404s, which is
     * the normal state for an installation that never uploaded a logo.
     */
    getLogo: asyncHandler(async (req, res) => {
        const file = await settingsService.resolveLogoFile();

        if (!file) {
            return res.status(404).json({
                success: false,
                message: 'No logo has been uploaded',
                code: 'NO_LOGO',
            });
        }

        // Cache longer than the branding read: the file only changes when the
        // upload endpoint writes a new one, and that gets a new URL-safe name.
        res.set('Cache-Control', 'public, max-age=86400');
        return res.sendFile(file);
    }),

    /**
     * PUT /api/admin/settings/branding
     * Saves the name, tagline, contact details and logo URL.
     */
    updateBranding: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        // req.provided.body lists the fields the client actually sent, which is
        // what makes this a partial update rather than a full replace. See the
        // note in validation.middleware.js about sanitised empty strings.
        const provided = req.provided?.body || new Set(Object.keys(payload));

        const branding = await settingsService.updateBranding(payload, req.user.id, provided);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BRANDING_UPDATED,
            entity: 'system_settings',
            entityId: '1',
            req,
            metadata: {
                // The values themselves, not the logo bytes: this records who
                // changed the visible name without copying a file reference.
                system_name: branding.systemName,
                logo_changed: branding.logoUrl !== undefined,
            },
        });

        return sendSuccess(res, 'Settings saved', { branding });
    }),

    /**
     * POST /api/admin/settings/logo
     * Multipart upload. multer has already validated the type and size and
     * replaced the filename with a generated, safe one.
     */
    uploadLogo: asyncHandler(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Please select an image to upload',
                code: 'NO_FILE',
            });
        }

        const branding = await settingsService.setLogo(toStoredPath(req.file), req.user.id);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.BRANDING_UPDATED,
            entity: 'system_settings',
            entityId: '1',
            req,
            metadata: { logo_uploaded: true },
        });

        return sendSuccess(res, 'Logo updated', { branding });
    }),
};

export default settingsController;
