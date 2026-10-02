/**
 * src/routes/users.routes.js
 *
 * WHAT THIS MODULE DOES
 * Profile self-service endpoints for the signed in user.
 *
 * WHY IT EXISTS
 * Every route here acts on `req.user`, which the authentication middleware
 * sets. No route accepts a user id from the client, so a guest cannot read or
 * modify another account by changing a URL.
 *
 * COMMUNICATION
 * Frontend (public/js/api/users.js) -> THIS FILE -> users.controller.js
 * Database tables used: users.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { writeLimiter } from '../middleware/rateLimit.middleware.js';
import { uploadSingle } from '../middleware/upload.middleware.js';
import { updateProfileRules, changeEmailRules } from '../validators/user.validators.js';
import userController from '../controllers/user.controller.js';

const router = Router();

// Everything below requires a valid session.
router.use(requireAuth);

router.get('/profile', userController.getProfile);

router.patch('/profile', validate(updateProfileRules), userController.updateProfile);

router.post('/profile/email', writeLimiter, validate(changeEmailRules), userController.changeEmail);

// multer parses the multipart body, so no JSON body parser applies here.
router.post('/profile/image', uploadSingle('avatars'), userController.uploadProfileImage);

router.delete('/profile/image', userController.removeProfileImage);

export default router;