/**
 * public/js/api/auth.js
 *
 * WHAT THIS MODULE DOES
 * Typed wrappers around the authentication endpoints.
 *
 * WHY IT EXISTS
 * Page scripts should describe intent ("signIn", "forgotPassword") rather
 * than repeat URLs and payload shapes. If an endpoint path changes, only this
 * file is edited.
 *
 * COMMUNICATION
 * Pages -> THIS FILE -> api.js -> POST /api/auth/*
 */
import api from './api.js';

export const auth = {
    /** Creates an account. The server sets the auth cookie in the response. */
    register: (payload) => api.post('/auth/register', payload),

    /** Signs in. Returns the user profile; the cookie is set by the server. */
    login: (email, password) => api.post('/auth/login', { email, password }),

    /** Clears the auth cookie. Safe to call when already signed out. */
    logout: () => api.post('/auth/logout'),

    /**
     * Resolves the current session.
     * Returns null rather than throwing when signed out, because "not signed
     * in" is a normal state for the public pages, not an error.
     */
    async me() {
        try {
            const result = await api.get('/auth/me');
            return result?.data?.user || null;
        } catch (error) {
            if (error.status === 401) return null;
            throw error;
        }
    },

    forgotPassword: (email) => api.post('/auth/forgot-password', { email }),

    /** Checks a reset link before showing the password form. */
    verifyResetToken: (token) => api.post('/auth/verify-reset-token', { token }),

    resetPassword: (token, password, confirmPassword) =>
        api.post('/auth/reset-password', { token, password, confirmPassword }),

    verifyEmail: (token) => api.post('/auth/verify-email', { token }),

    resendVerification: () => api.post('/auth/resend-verification'),

    changePassword: (currentPassword, newPassword, confirmPassword) =>
        api.post('/auth/change-password', { currentPassword, newPassword, confirmPassword }),
};

export default auth;