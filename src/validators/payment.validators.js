/**
 * src/validators/payment.validators.js
 *
 * WHAT THIS MODULE DOES
 * Declares the rules that a payment request must satisfy before any controller
 * or service code runs.
 *
 * WHY IT EXISTS
 * Validating here means a malformed card number never reaches the provider,
 * and the messages are defined next to the field they belong to rather than
 * being invented inside a service.
 *
 * A NOTE ON SENSITIVE FIELDS
 * `cardNumber` and `cvv` are declared as required but are deliberately not
 * persisted anywhere. Validating the shape here is a usability measure: it
 * catches an obviously incomplete form before it costs a provider round trip.
 * The authoritative check is the Luhn test inside the provider.
 *
 * COMMUNICATION
 * Used by: routes/payments.routes.js via middleware/validation.middleware.js
 */
import { body, param, query } from 'express-validator';

const PAYMENT_METHODS = ['card', 'mobile_money', 'cash'];

/** Card details, required only when the chosen method is a card. */
const cardFields = [
    body('cardNumber')
        .optional()
        .trim()
        .matches(/^[0-9 ]{13,23}$/)
        .withMessage('Enter a valid card number')
        // Removes the spaces people paste in, so the provider sees digits only.
        .customSanitizer((value) => String(value).replace(/\s+/g, '')),
    body('cardHolder').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Enter the name on the card'),
    body('expiryMonth')
        .optional()
        .isInt({ min: 1, max: 12 })
        .withMessage('Expiry month must be between 1 and 12')
        .toInt(),
    body('expiryYear')
        .optional()
        // Anchored to the current year rather than a hard coded 2024, which
        // would start rejecting perfectly valid cards as the calendar moves on.
        .isInt({ min: new Date().getFullYear(), max: 2099 })
        .withMessage('Enter a valid expiry year')
        .toInt(),
    body('cvv').optional().matches(/^[0-9]{3,4}$/).withMessage('Enter the security code'),
];

/**
 * Rejects a card payment that is missing card fields, while leaving a cash or
 * mobile money payment free of them.
 *
 * Doing it with a single conditional rule keeps the alternative out of the
 * route, where it would otherwise need a separate branch per method.
 *
 * WHY THIS THROWS INSTEAD OF RETURNING A MESSAGE
 * Returning a non-empty string looks like it should fail the chain, and it
 * does not: express-validator treats any truthy return as success, so a
 * returned message was silently discarded and an incomplete card form sailed
 * through to the service. Throwing is the only way to register the failure.
 */
function requireCardDetailsWhenCard(data) {
    if (data.method !== 'card') return true;

    const missing = ['cardNumber', 'cardHolder', 'expiryMonth', 'expiryYear', 'cvv'].filter(
        (field) => !data[field],
    );

    if (missing.length > 0) {
        throw new Error(`Complete the card details: ${missing.join(', ')}`);
    }

    return true;
}

export const createPaymentRules = [
    body('entity').isIn(['booking', 'order']).withMessage('Specify a booking or an order'),
    body('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
    body('method').isIn(PAYMENT_METHODS).withMessage('Choose a valid payment method'),
    ...cardFields,
    body('mobileNumber')
        .optional({ values: 'falsy' })
        .trim()
        .matches(/^[0-9+\-\s]{9,20}$/)
        .withMessage('Enter a valid mobile money number'),
    // Lets the payment form demonstrate the decline and cancel paths on demand.
    body('outcome')
        .optional()
        .isIn(['success', 'failure', 'cancel', 'insufficient_funds'])
        .withMessage('Unknown simulation outcome'),
    body('reason').optional().trim().isLength({ max: 255 }).withMessage('Reason is too long'),
    body().custom((value) => {
        if (value.method === 'mobile_money' && !value.mobileNumber) {
            throw new Error('A mobile number is required for mobile money payments');
        }
        return true;
    }),
    body().custom(requireCardDetailsWhenCard),
];

export const listPaymentsRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .custom((value) =>
            value
                .split(',')
                .every((item) =>
                    ['pending', 'processing', 'completed', 'failed', 'refunded'].includes(item.trim()),
                ),
        )
        .withMessage('Unknown payment status'),
    query('method').optional().isIn(PAYMENT_METHODS).withMessage('Unknown payment method'),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
];

export const paymentIdRules = [param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt()];

export const refundRules = [
    param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
    body('reason').optional().trim().isLength({ max: 255 }).withMessage('Reason is too long'),
];

export const receiptRules = [
    query('entity').isIn(['booking', 'order']).withMessage('Specify a booking or an order'),
    query('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
];

export const invoiceIdRules = [param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt()];

export const listInvoicesRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .isIn(['unpaid', 'partially_paid', 'paid', 'void'])
        .withMessage('Unknown invoice status'),
    query('search').optional().trim().isLength({ min: 1, max: 120 }).withMessage('Search term is too long'),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
];
