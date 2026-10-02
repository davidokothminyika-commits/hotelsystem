/**
 * src/validators/booking.validators.js
 *
 * WHAT THIS MODULE DOES
 * Validation rules for room search, availability queries and booking creation.
 *
 * WHY IT EXISTS
 * The date and guest-count rules are the same on the booking form, the
 * availability search and the receptionist's booking screen. Declaring them
 * once keeps those three entry points consistent.
 *
 * COMMUNICATION
 * Used by: src/routes/rooms.routes.js and src/routes/bookings.routes.js
 * Database tables used: none.
 */
import { body, param, query } from 'express-validator';

/** A date in YYYY-MM-DD that must also be a real calendar date. */
const dateRule = (field, label) =>
    query(field)
        .optional()
        .isISO8601({ strict: true })
        .withMessage(`${label} must be a valid date in YYYY-MM-DD format`)
        .toDate();

const dateBodyRule = (field, label) =>
    body(field)
        .notEmpty()
        .withMessage(`${label} is required`)
        .bail()
        .isISO8601({ strict: true })
        .withMessage(`${label} must be a valid date in YYYY-MM-DD format`)
        .toDate();

export const idParamRules = [
    param('id').isInt({ min: 1 }).withMessage('Invalid identifier').toInt(),
];

// ---------------------------------------------------------------------------
// Room search
// ---------------------------------------------------------------------------

export const availabilityRules = [
    query('checkIn')
        .optional()
        .isISO8601({ strict: true })
        .withMessage('Check-in must be a valid date in YYYY-MM-DD format'),
    query('checkOut')
        .optional()
        .isISO8601({ strict: true })
        .withMessage('Check-out must be a valid date in YYYY-MM-DD format'),
    query('guests')
        .optional()
        .isInt({ min: 1, max: 20 })
        .withMessage('Number of guests must be between 1 and 20')
        .toInt(),
    query('roomType')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Invalid room type')
        .toInt(),
    query('minPrice')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Minimum price must be zero or greater')
        .toFloat(),
    query('maxPrice')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Maximum price must be zero or greater')
        .toFloat(),
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Invalid page size').toInt(),
    query('sortBy')
        .optional()
        .isIn(['r.price_per_night', 'r.capacity', 'r.room_number', 'r.floor', 'rt.name', 'r.created_at'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

export const roomListRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('roomType').optional().isInt({ min: 1 }).withMessage('Invalid room type').toInt(),
    query('status')
        .optional()
        .isIn(['available', 'occupied', 'reserved', 'maintenance', 'cleaning'])
        .withMessage('Invalid room status'),
    query('floor').optional().isInt({ min: 1 }).withMessage('Invalid floor').toInt(),
    query('minPrice').optional().isFloat({ min: 0 }).withMessage('Invalid minimum price').toFloat(),
    query('maxPrice').optional().isFloat({ min: 0 }).withMessage('Invalid maximum price').toFloat(),
    query('sortBy')
        .optional()
        .isIn(['r.price_per_night', 'r.capacity', 'r.room_number', 'r.floor', 'rt.name', 'r.created_at'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

// ---------------------------------------------------------------------------
// Booking creation
// ---------------------------------------------------------------------------

export const createBookingRules = [
    body('roomId')
        .notEmpty()
        .withMessage('Please choose a room')
        .bail()
        .isInt({ min: 1 })
        .withMessage('Invalid room')
        .toInt(),

    dateBodyRule('checkIn', 'Check-in date'),
    dateBodyRule('checkOut', 'Check-out date'),

    body('guests')
        .optional()
        .isInt({ min: 1, max: 20 })
        .withMessage('Number of guests must be between 1 and 20')
        .toInt(),

    body('adults').optional().isInt({ min: 1, max: 20 }).withMessage('Invalid number of adults').toInt(),
    body('children').optional().isInt({ min: 0, max: 20 }).withMessage('Invalid number of children').toInt(),

    body('specialRequests')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ max: 1000 })
        .withMessage('Special requests must be under 1000 characters'),

    // Additional named guests travelling with the primary guest.
    body('guestNames')
        .optional()
        .isArray({ max: 8 })
        .withMessage('A maximum of 8 additional guests may be listed')
        .custom((guests) =>
            guests.every(
                (guest) =>
                    typeof guest === 'object' &&
                    guest !== null &&
                    typeof guest.firstName === 'string' &&
                    guest.firstName.trim().length >= 2,
            ),
        )
        .withMessage('Each guest needs a first name of at least 2 characters'),
];

export const listBookingsRules = [
    query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number').toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid page size').toInt(),
    query('status')
        .optional()
        .custom((value) =>
            value
                .split(',')
                .every((item) => ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'].includes(item.trim())),
        )
        .withMessage('Invalid booking status'),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term is too long'),
    query('userId').optional().isInt({ min: 1 }).withMessage('Invalid user').toInt(),
    query('sortBy')
        .optional()
        .isIn(['b.created_at', 'b.check_in', 'b.check_out', 'b.total_amount', 'b.status'])
        .withMessage('Cannot sort by that column'),
    query('sortDir').optional().isIn(['asc', 'desc']).withMessage('Invalid sort direction'),
];

export const cancelBookingRules = [
    body('reason').optional().trim().isLength({ max: 255 }).withMessage('Reason is too long'),
];

export const updateRoomStatusRules = [
    body('status')
        .notEmpty()
        .withMessage('A status is required')
        .bail()
        .isIn(['available', 'occupied', 'reserved', 'maintenance', 'cleaning'])
        .withMessage('Invalid room status'),
];

export const createRoomRules = [
    body('roomNumber')
        .trim()
        .notEmpty()
        .withMessage('Room number is required')
        .bail()
        .matches(/^[A-Za-z0-9-]{1,10}$/)
        .withMessage('Room number may contain letters, numbers and hyphens only'),
    body('roomTypeId').isInt({ min: 1 }).withMessage('Please choose a room type').toInt(),
    body('floor').isInt({ min: 0, max: 200 }).withMessage('Invalid floor').toInt(),
    body('capacity').isInt({ min: 1, max: 20 }).withMessage('Invalid capacity').toInt(),
    body('pricePerNight').isFloat({ min: 0 }).withMessage('Invalid nightly price').toFloat(),
    body('description').optional().trim().isLength({ max: 2000 }).withMessage('Description is too long'),
    body('status')
        .optional()
        .isIn(['available', 'occupied', 'reserved', 'maintenance', 'cleaning'])
        .withMessage('Invalid room status'),
];

export const updateRoomRules = [
    body('roomNumber')
        .optional()
        .trim()
        .matches(/^[A-Za-z0-9-]{1,10}$/)
        .withMessage('Room number may contain letters, numbers and hyphens only'),
    body('roomTypeId').optional().isInt({ min: 1 }).withMessage('Invalid room type').toInt(),
    body('floor').optional().isInt({ min: 0, max: 200 }).withMessage('Invalid floor').toInt(),
    body('capacity').optional().isInt({ min: 1, max: 20 }).withMessage('Invalid capacity').toInt(),
    body('pricePerNight').optional().isFloat({ min: 0 }).withMessage('Invalid nightly price').toFloat(),
    body('description').optional().trim().isLength({ max: 2000 }).withMessage('Description is too long'),
    body('status')
        .optional()
        .isIn(['available', 'occupied', 'reserved', 'maintenance', 'cleaning'])
        .withMessage('Invalid room status'),
];

export default {
    idParamRules,
    availabilityRules,
    roomListRules,
    createBookingRules,
    listBookingsRules,
    cancelBookingRules,
    updateRoomStatusRules,
    createRoomRules,
    updateRoomRules,
};