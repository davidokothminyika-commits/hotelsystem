/**
 * src/validators/auth.validators.js
 *
 * WHAT THIS MODULE DOES
 * Declares the validation rules for every authentication endpoint.
 *
 * WHY IT EXISTS
 * Rules are declared as data next to the route they protect, so reading a
 * route shows its contract. The service layer repeats the critical checks so
 * it stays safe when called internally.
 *
 * COMMUNICATION
 * Used by: src/routes/auth.routes.js via `validate(...)`.
 * Read by: middleware/validation.middleware.js.
 * Database tables used: none.
 */
import { body } from 'express-validator';

/**
 * Shared email rule. `normalizeEmail` lowercases the domain and trims, so
 * `  User@Example.COM ` and `user@example.com` become one account.
 */
const emailRule = body('email')
    .trim()
    .notEmpty()
    .withMessage('Email address is required')
    .bail()
    .isEmail()
    .withMessage('Please enter a valid email address')
    .normalizeEmail({ gmail_remove_dots: false })
    .isLength({ max: 190 })
    .withMessage('Email address is too long');

const passwordRule = body('password')
    .notEmpty()
    .withMessage('Password is required')
    .bail()
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be between 8 and 128 characters');

/** Registration rules. */
export const registerRules = [
    body('firstName')
        .trim()
        .notEmpty()
        .withMessage('First name is required')
        .bail()
        .isLength({ min: 2, max: 80 })
        .withMessage('First name must be between 2 and 80 characters')
        .matches(/^[\p{L}\s'.-]+$/u)
        .withMessage('First name may only contain letters, spaces, apostrophes, dots and hyphens'),

    body('lastName')
        .trim()
        .notEmpty()
        .withMessage('Last name is required')
        .bail()
        .isLength({ min: 2, max: 80 })
        .withMessage('Last name must be between 2 and 80 characters')
        .matches(/^[\p{L}\s'.-]+$/u)
        .withMessage('Last name may only contain letters, spaces, apostrophes, dots and hyphens'),

    emailRule,

    body('phone')
        .optional({ values: 'falsy' })
        .trim()
        .matches(/^[+]?[\d\s()-]{7,20}$/)
        .withMessage('Please enter a valid phone number'),

    passwordRule,

    body('confirmPassword')
        .notEmpty()
        .withMessage('Please confirm your password')
        .bail()
        .custom((value, { req }) => value === req.body.password)
        .withMessage('Passwords do not match'),

    // Accepted for the form's benefit but ignored by the service: public
    // signup can only ever create a guest account.
    body('agreeToTerms')
        .optional()
        .isBoolean()
        .withMessage('Invalid terms agreement value'),
];

/** Login rules. */
export const loginRules = [
    emailRule,
    body('password').notEmpty().withMessage('Password is required'),
];

/** Forgot password: only an email is needed. */
export const forgotPasswordRules = [emailRule];

/** Reset password: token plus the new password pair. */
export const resetPasswordRules = [
    body('token')
        .notEmpty()
        .withMessage('Reset token is missing')
        .bail()
        .isLength({ min: 32, max: 128 })
        .withMessage('Reset token is not valid'),

    passwordRule,

    body('confirmPassword')
        .notEmpty()
        .withMessage('Please confirm your new password')
        .bail()
        .custom((value, { req }) => value === req.body.password)
        .withMessage('Passwords do not match'),
];

/** Change password while signed in. */
export const changePasswordRules = [
    body('currentPassword').notEmpty().withMessage('Your current password is required'),

    // Named `newPassword` here (not `password`) so the field is unambiguous
    // next to `currentPassword` in both the request and the response.
    body('newPassword')
        .notEmpty()
        .withMessage('A new password is required')
        .bail()
        .isLength({ min: 8, max: 128 })
        .withMessage('Password must be between 8 and 128 characters'),

    body('confirmPassword')
        .notEmpty()
        .withMessage('Please confirm your new password')
        .bail()
        .custom((value, { req }) => value === req.body.newPassword)
        .withMessage('Passwords do not match'),
];

/** Token verification for the reset password page. */
export const resetTokenRules = [
    body('token').notEmpty().withMessage('Reset token is missing'),
];

/** Email verification. */
export const verifyEmailRules = [
    body('token')
        .notEmpty()
        .withMessage('Verification token is missing')
        .bail()
        .isLength({ min: 32, max: 128 })
        .withMessage('Verification token is not valid'),
];

/** Profile update. Email is intentionally NOT updatable here: changing an
 *  address requires re-verification, which is handled separately. */
export const updateProfileRules = [
    body('firstName')
        .trim()
        .notEmpty()
        .withMessage('First name is required')
        .bail()
        .isLength({ min: 2, max: 80 })
        .withMessage('First name must be between 2 and 80 characters')
        .matches(/^[\p{L}\s'.-]+$/u)
        .withMessage('First name may only contain letters, spaces, apostrophes, dots and hyphens'),

    body('lastName')
        .trim()
        .notEmpty()
        .withMessage('Last name is required')
        .bail()
        .isLength({ min: 2, max: 80 })
        .withMessage('Last name must be between 2 and 80 characters')
        .matches(/^[\p{L}\s'.-]+$/u)
        .withMessage('Last name may only contain letters, spaces, apostrophes, dots and hyphens'),

    body('phone')
        .optional({ values: 'falsy' })
        .trim()
        .matches(/^[+]?[\d\s()-]{7,20}$/)
        .withMessage('Please enter a valid phone number'),
];

export default {
    registerRules,
    loginRules,
    forgotPasswordRules,
    resetPasswordRules,
    changePasswordRules,
    resetTokenRules,
    verifyEmailRules,
    updateProfileRules,
};