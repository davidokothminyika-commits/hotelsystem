/**
 * src/validators/restaurant.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for menu browsing and order placement.
 *
 * COMMUNICATION
 * Used by: src/routes/menu.routes.js and src/routes/orders.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';

export const idParamRules = [
    param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
];

/** Menu browsing filters. */
export const browseMenuRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 60 }).withMessage('Invalid page size').toInt(),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('category').optional().isInt({ min: 1 }).withMessage('Invalid category').toInt(),
    query('categorySlug')
        .optional()
        .isIn(['breakfast', 'lunch', 'dinner', 'drinks', 'desserts', 'snacks'])
        .withMessage('Unknown category'),
    query('vegetarian').optional().isBoolean().withMessage('Invalid filter value').toBoolean(),
    query('spicy').optional().isBoolean().withMessage('Invalid filter value').toBoolean(),
    query('featured').optional().isBoolean().withMessage('Invalid filter value').toBoolean(),
    query('maxPrice').optional().isFloat({ min: 0 }).withMessage('Invalid maximum price').toFloat(),
    query('sortBy')
        .optional()
        .isIn(['mi.name', 'mi.price', 'mi.created_at', 'mi.prep_minutes'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

/**
 * Order placement.
 *
 * Note what is absent: price. No price field is accepted, because the server
 * resolves every price from the database. Accepting one would imply it could
 * be honoured.
 */
export const placeOrderRules = [
    body('items')
        .isArray({ min: 1 })
        .withMessage('Your order is empty')
        .bail()
        .custom((items) =>
            items.every(
                (item) =>
                    item !== null &&
                    typeof item === 'object' &&
                    Number.isInteger(Number(item.menuItemId)) &&
                    Number(item.menuItemId) > 0 &&
                    Number.isInteger(Number(item.quantity)) &&
                    Number(item.quantity) > 0,
            ),
        )
        .withMessage('Each item needs a menu item id and a whole quantity of at least one'),

    body('fulfilmentType')
        .notEmpty()
        .withMessage('Choose room delivery or restaurant pickup')
        .bail()
        .isIn(['room_delivery', 'restaurant_pickup'])
        .withMessage('Invalid fulfilment type'),

    // Required for delivery, ignored for pickup. The service enforces that it
    // is present when it matters; the validator only checks the shape.
    body('roomId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid room')
        .toInt(),

    body('bookingId').optional().isInt({ min: 1 }).withMessage('Invalid booking').toInt(),

    body('specialRequests').optional().trim().isLength({ max: 1000 }).withMessage('Requests are too long'),
    body('deliveryNotes').optional().trim().isLength({ max: 255 }).withMessage('Notes are too long'),
];

export const listOrdersRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .custom((value) =>
            value
                .split(',')
                .every((item) =>
                    ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'].includes(
                        item.trim(),
                    ),
                ),
        )
        .withMessage('Invalid order status'),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('fulfilmentType')
        .optional()
        .isIn(['room_delivery', 'restaurant_pickup'])
        .withMessage('Invalid fulfilment type'),
    query('roomId').optional().isInt({ min: 1 }).withMessage('Invalid room').toInt(),
];

export const updateOrderStatusRules = [
    body('status')
        .notEmpty()
        .withMessage('A status is required')
        .bail()
        .isIn(['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'])
        .withMessage('Invalid order status'),
];

export const cancelOrderRules = [
    body('reason').optional().trim().isLength({ max: 255 }).withMessage('Reason is too long'),
];

// ---------------------------------------------------------------------------
// Menu administration
// ---------------------------------------------------------------------------

export const createMenuItemRules = [
    body('categoryId').isInt({ min: 1 }).withMessage('Choose a category').toInt(),
    body('name')
        .trim()
        .notEmpty()
        .withMessage('A name is required')
        .bail()
        .isLength({ min: 2, max: 120 })
        .withMessage('Name must be between 2 and 120 characters'),
    body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description is too long'),
    body('price').isFloat({ min: 0.01, max: 9999 }).withMessage('Enter a valid price').toFloat(),
    body('prepMinutes').optional().isInt({ min: 1, max: 240 }).withMessage('Invalid preparation time').toInt(),
    body('isVegetarian').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isSpicy').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isFeatured').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isAvailable').optional().isBoolean().withMessage('Invalid value').toBoolean(),
];

export const updateMenuItemRules = [
    body('categoryId').optional().isInt({ min: 1 }).withMessage('Invalid category').toInt(),
    body('name').optional().trim().isLength({ min: 2, max: 120 }).withMessage('Name must be between 2 and 120 characters'),
    body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description is too long'),
    body('price').optional().isFloat({ min: 0.01, max: 9999 }).withMessage('Enter a valid price').toFloat(),
    body('prepMinutes').optional().isInt({ min: 1, max: 240 }).withMessage('Invalid preparation time').toInt(),
    body('isVegetarian').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isSpicy').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isFeatured').optional().isBoolean().withMessage('Invalid value').toBoolean(),
    body('isAvailable').optional().isBoolean().withMessage('Invalid value').toBoolean(),
];

export const setAvailabilityRules = [
    body('isAvailable').isBoolean().withMessage('An availability flag is required').toBoolean(),
];

export default {
    idParamRules,
    browseMenuRules,
    placeOrderRules,
    listOrdersRules,
    updateOrderStatusRules,
    cancelOrderRules,
    createMenuItemRules,
    updateMenuItemRules,
    setAvailabilityRules,
};