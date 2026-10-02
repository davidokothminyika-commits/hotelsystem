/**
 * src/utils/response.js
 *
 * WHAT THIS MODULE DOES
 * Builds the two response envelopes used by every endpoint in the API.
 *
 * WHY IT EXISTS
 * Centralising the envelope means the frontend can rely on one contract:
 *   success -> { success: true,  message, data }
 *   failure -> { success: false, message, code, errors? }
 * No endpoint invents its own shape, so `api.js` on the frontend only needs
 * one place to unwrap responses and surface errors.
 *
 * COMMUNICATION
 * Used by: all controllers.
 * Read by: public/js/api/api.js (the fetch wrapper).
 */

export function sendSuccess(res, message = 'Request completed successfully', data = undefined, status = 200) {
    const body = { success: true, message };
    if (data !== undefined) body.data = data;
    return res.status(status).json(body);
}

export function sendCreated(res, message = 'Resource created successfully', data = undefined) {
    return sendSuccess(res, message, data, 201);
}

/**
 * Paginated responses keep `data` as the array itself and expose paging
 * metadata under `meta`, so the frontend pagination component always knows
 * where it stands without parsing the payload.
 */
export function sendPaginated(res, rows, { page, limit, total }, message = 'Records retrieved successfully') {
    return res.status(200).json({
        success: true,
        message,
        data: rows,
        meta: {
            page,
            limit,
            total,
            totalPages: limit > 0 ? Math.ceil(total / limit) : 1,
            hasNext: page * limit < total,
            hasPrev: page > 1,
        },
    });
}

export function sendError(res, message = 'Request failed', code = 'INTERNAL_ERROR', status = 500, errors = undefined) {
    const body = { success: false, message, code };
    if (errors !== undefined) body.errors = errors;
    return res.status(status).json(body);
}

export default { sendSuccess, sendCreated, sendPaginated, sendError };