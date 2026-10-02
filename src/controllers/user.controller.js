/**
 * src/controllers/user.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for profile self-service.
 *
 * WHY IT EXISTS
 * Keeps request/response translation out of the service. Every handler here
 * acts on `req.user` (the authenticated account) rather than an id from the
 * URL, which is what prevents a guest editing someone else's profile.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/user.service.js -> repositories -> MySQL
 * Frontend calls: public/js/api/users.js
 */
import { sendSuccess } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import { toStoredPath } from '../middleware/upload.middleware.js';
import userService from '../services/user.service.js';

const userController = {
    /** GET /api/users/profile */
    getProfile: asyncHandler(async (req, res) => {
        const user = await userService.getProfile(req.user.id);
        return sendSuccess(res, 'Profile retrieved', { user });
    }),

    /** PATCH /api/users/profile */
    updateProfile: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const user = await userService.updateProfile(req.user.id, payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.PROFILE_UPDATED,
            entity: 'users',
            entityId: req.user.id,
            req,
            metadata: { fields: Object.keys(payload) },
        });

        return sendSuccess(res, 'Profile updated successfully', { user });
    }),

    /** POST /api/users/profile/email */
    changeEmail: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const user = await userService.changeEmail(req.user.id, payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.PROFILE_UPDATED,
            entity: 'users',
            entityId: req.user.id,
            req,
            metadata: { email_changed: true },
        });

        return sendSuccess(
            res,
            'Email address updated. Please check your inbox to verify the new address.',
            { user },
        );
    }),

    /**
     * POST /api/users/profile/image
     * Multipart form upload. multer has already validated the file type and
     * size, and replaced the filename with a generated safe one.
     */
    uploadProfileImage: asyncHandler(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Please select an image to upload',
                code: 'NO_FILE',
            });
        }

        const user = await userService.updateProfileImage(req.user.id, toStoredPath(req.file));

        return sendSuccess(res, 'Profile image updated', { user });
    }),

    /** DELETE /api/users/profile/image */
    removeProfileImage: asyncHandler(async (req, res) => {
        const user = await userService.removeProfileImage(req.user.id);
        return sendSuccess(res, 'Profile image removed', { user });
    }),
};

export default userController;