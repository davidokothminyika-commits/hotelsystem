/**
 * src/services/user.service.js
 *
 * WHAT THIS MODULE DOES
 * Profile and account self-service: reading and updating a user's own
 * profile, changing their avatar, and managing their notification settings.
 *
 * WHY IT EXISTS
 * Separates "a user changing their own details" from "an administrator
 * changing anyone's details" (admin.service.js). The permission rules differ:
 * self-service requires no elevated role but must be scoped to req.user.id,
 * while admin operations require role checks.
 *
 * COMMUNICATION
 * Browser -> /api/users/* -> users.controller.js -> THIS FILE
 *        -> user.repository.js, notification.service.js
 * Database tables used: users, notifications.
 */
import bcrypt from 'bcryptjs';
import ApiError from '../utils/errors.js';
import userRepository from '../repositories/user.repository.js';
import { deleteUploadedFile } from '../middleware/upload.middleware.js';

const userService = {
    /** Returns the signed in user's full profile. */
    async getProfile(userId) {
        const user = await userRepository.findById(userId);
        if (!user) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');
        return user;
    },

    /**
     * Updates the signed in user's editable fields.
     *
     * Note what is NOT here: email and role. Changing an email requires
     * re-verification, and changing a role is an administrator action.
     * Accepting them silently would be a privilege escalation.
     */
    async updateProfile(userId, { firstName, lastName, phone }) {
        if (!firstName || !lastName) {
            throw ApiError.badRequest('First name and last name are required', 'MISSING_FIELDS');
        }

        const user = await userRepository.updateProfile(userId, { firstName, lastName, phone });
        return user;
    },

    /**
     * Stores a new profile image and removes the previous one.
     * The controller passes the already-saved (safely named) file path.
     */
    async updateProfileImage(userId, storedPath) {
        const current = await userRepository.findById(userId);
        if (!current) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');

        await userRepository.updateProfileImage(userId, storedPath);

        // Delete the old file so uploads do not accumulate. Failure to delete
        // is logged but must not fail the request.
        if (current.profileImage) {
            deleteUploadedFile(current.profileImage);
        }

        return this.getProfile(userId);
    },

    /** Removes the avatar and reverts to the initials placeholder. */
    async removeProfileImage(userId) {
        const current = await userRepository.findById(userId);
        if (!current) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');

        await userRepository.updateProfileImage(userId, null);
        if (current.profileImage) deleteUploadedFile(current.profileImage);

        return this.getProfile(userId);
    },

    /**
     * Changes the signed in user's email address.
     *
     * The address is set as unverified and a new verification token is
     * issued, so the new owner must prove control of the mailbox before the
     * account is trusted with it again.
     */
    async changeEmail(userId, { email, password }) {
        const record = await userRepository.findByIdWithPassword(userId);
        if (!record) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');

        // Re-authenticating prevents a hijacked session from repointing the
        // account email, which is a common account-takeover path.
        const matches = await bcrypt.compare(password, record.password_hash);
        if (!matches) {
            throw ApiError.badRequest('Your password is incorrect', 'INVALID_PASSWORD');
        }

        const normalised = email.trim().toLowerCase();

        if (normalised === record.email) {
            throw ApiError.badRequest('That is already your email address', 'EMAIL_UNCHANGED');
        }

        const existing = await userRepository.findByEmail(normalised);
        if (existing && existing.id !== userId) {
            throw ApiError.conflict('An account with that email already exists', 'EMAIL_ALREADY_REGISTERED');
        }

        await userRepository.updateEmail(userId, normalised);
        await userRepository.clearEmailVerification(userId);

        const updated = await userRepository.findById(userId);
        await this.sendVerification(updated);

        return updated;
    },

    /** Issues a fresh verification email for the signed in user. */
    async sendVerification(user) {
        // Imported lazily to avoid a circular dependency between the auth
        // service and this one: auth.service imports nothing from here, but
        // keeping the import local documents the relationship clearly.
        const { default: authService } = await import('./auth.service.js');
        return authService.sendVerificationEmail(user);
    },
};

export default userService;