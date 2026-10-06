/**
 * src/validators/settings.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for the branding an administrator can change.
 *
 * WHY IT EXISTS
 * Keeps the input rules next to the equivalent rules for every other form, so
 * the limits are stated once and the service never has to guess what a valid
 * address looks like.
 *
 * WHY EVERY FIELD IS OPTIONAL
 * This is a PATCH-style save: the admin form submits the whole form, but the
 * logo is sent through a separate upload endpoint. Requiring each field would
 * reject a save that only wants to change the name.
 *
 * COMMUNICATION
 * Used by: src/routes/settings.routes.js
 * Database tables used: none.
 */
import { body } from 'express-validator';

/** Strips a value that is only whitespace, so '' and '   ' behave the same. */
const optionalText = (field, label, max) =>
    body(field)
        .optional()
        .trim()
        .isLength({ max })
        .withMessage(`${label} must be ${max} characters or fewer`);

export const updateBrandingRules = [
    body('systemName')
        .trim()
        .notEmpty()
        .withMessage('The system name is required')
        .bail()
        .isLength({ min: 2, max: 120 })
        .withMessage('The system name must be between 2 and 120 characters'),

    optionalText('tagline', 'The tagline', 150),

    // Same rule the profile form uses, so a phone number typed here and typed
    // on the profile are accepted identically.
    body('contactPhone')
        .optional({ values: 'falsy' })
        .trim()
        .matches(/^[+]?[\d\s()-]{7,20}$/)
        .withMessage('Please enter a valid phone number'),

    body('contactEmail')
        .optional({ values: 'falsy' })
        .trim()
        .isEmail()
        .withMessage('Please enter a valid email address')
        .normalizeEmail({ gmail_remove_dots: false })
        .isLength({ max: 190 })
        .withMessage('Email address is too long'),

    optionalText('contactAddress', 'The address', 255),

    // An empty string is meaningful: it clears the logo. Only http(s) is
    // allowed, because the value is rendered straight into an img src.
    body('logoUrl')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('The logo URL is too long')
        .bail()
        .custom((value) => {
            if (!value) return true;
            try {
                const { protocol } = new URL(value);
                return protocol === 'http:' || protocol === 'https:';
            } catch {
                return false;
            }
        })
        .withMessage('The logo URL must be a full http:// or https:// address'),
];

export default { updateBrandingRules };
