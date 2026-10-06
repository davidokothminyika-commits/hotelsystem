/**
 * src/routes/settings.routes.js
 *
 * WHAT THIS MODULE DOES
 * Serves the hotel's branding: the public read every page needs, and the
 * administrator-only endpoints that change it.
 *
 * WHY THE PUBLIC ROUTES COME FIRST
 * The two routes below the guard are deliberately declared above it. A guest
 * must be able to read the name and load the logo before signing in, so the
 * `router.use(requireRole('admin'))` line marks the boundary: everything after
 * it is admin only. Adding a new admin route below that line cannot
 * accidentally be exposed, which is the mistake a per-route guard invites.
 *
 * COMMUNICATION
 * Frontend -> THIS FILE -> controllers/settings.controller.js
 * Database tables used: system_settings (via the service).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { uploadSingle } from '../middleware/upload.middleware.js';
import { updateBrandingRules } from '../validators/settings.validators.js';
import settingsController from '../controllers/settings.controller.js';

const router = Router();

// ---------------------------------------------------------------------------
// Public: needed by every page, signed in or not
// ---------------------------------------------------------------------------

router.get('/branding', settingsController.getBranding);

router.get('/logo', settingsController.getLogo);

// ---------------------------------------------------------------------------
// Administrator only
// ---------------------------------------------------------------------------

router.use(requireAuth, requireRole('admin'));

router.put('/branding', writeLimiter, validate(updateBrandingRules), settingsController.updateBranding);

// 'hotel' is an accepted upload folder: the logo is hotel branding rather than
// a room, dish or avatar, so it does not belong in any of those folders.
router.post(
    '/logo',
    writeLimiter,
    uploadSingle('hotel'),
    settingsController.uploadLogo,
);

export default router;
