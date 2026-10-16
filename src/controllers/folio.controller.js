/**
 * src/controllers/folio.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for the guest folio: the board the front desk works from, the
 * ledger of one booking, and the write endpoints that move money on it.
 *
 * WHY THE FOLIO CONTROLLER RECORDS MORE METADATA THAN MOST
 * A posted charge or a void is a money event. The audit metadata carries the
 * type, the amount and the description so a dispute can be reconstructed from
 * the audit log alone, without decoding a folio row.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/folio.service.js
 * Frontend: public/js/pages/staff/folios.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import folioService from '../services/folio.service.js';

const folioController = {
    /** GET /api/folios - the front desk board */
    list: asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await folioService.listFolios({
            page: query.page,
            limit: query.limit,
            search: query.search,
            // 'all' is the UI wording for no filter; the repository expects
            // undefined rather than the string itself.
            status: query.status === 'all' ? undefined : query.status,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Folios retrieved',
        );
    }),

    /** GET /api/folios/:bookingId - one folio and its ledger */
    detail: asyncHandler(async (req, res) => {
        const folio = await folioService.getFolio(req.params.bookingId, req.user);
        return sendSuccess(res, 'Folio retrieved', { folio });
    }),

    /** POST /api/folios/:bookingId/entries */
    postEntry: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;

        const { entry, breakdown } = await folioService.postEntry(
            req.params.bookingId,
            payload,
            req.user,
        );

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.FOLIO_ENTRY_POSTED,
            entity: 'folios',
            entityId: req.params.bookingId,
            req,
            metadata: {
                entry_id: entry?.id,
                entry_type: entry?.entryType,
                amount: entry?.amount,
                description: entry?.description,
                new_total: breakdown?.totalAmount,
            },
        });

        return sendCreated(res, 'Folio entry posted', { entry, breakdown });
    }),

    /** POST /api/folios/:bookingId/entries/:entryId/void */
    voidEntry: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || {};

        const { entry, breakdown } = await folioService.voidEntry(
            req.params.bookingId,
            req.params.entryId,
            payload.reason,
            req.user,
        );

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.FOLIO_ENTRY_VOIDED,
            entity: 'folios',
            entityId: req.params.bookingId,
            req,
            metadata: {
                entry_id: entry?.id,
                entry_type: entry?.entryType,
                amount: entry?.amount,
                void_reason: entry?.voidReason || null,
                new_total: breakdown?.totalAmount,
            },
        });

        return sendSuccess(res, 'Folio entry voided', { entry, breakdown });
    }),
};

export default folioController;
