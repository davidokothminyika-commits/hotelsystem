/**
 * src/controllers/audit.controller.js
 *
 * WHAT THIS MODULE DOES
 * Exposes the audit log to administrators.
 *
 * WHY IT EXISTS
 * The audit trail is written by middleware and services throughout the app, but
 * nothing read it back. This is the read side: it exists so an administrator
 * can answer "who changed this, and when" without querying the database.
 *
 * READ ONLY BY DESIGN
 * There is no create, update or delete route for audit entries. An audit log
 * that can be edited through the same API that reads it is not an audit log.
 * Rows are only ever removed by the retention job in the repository.
 *
 * COMMUNICATION
 * Browser -> /api/audit-logs -> THIS FILE -> services/audit.service.js
 * Database tables used: none (the service owns persistence).
 */
import auditService from '../services/audit.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { sendSuccess, sendPaginated } from '../utils/response.js';

const auditController = {
    /** GET /api/audit-logs */
    list: asyncHandler(async (req, res) => {
        const result = await auditService.list({
            page: req.query.page,
            limit: req.query.limit,
            search: req.query.search,
            action: req.query.action,
            userId: req.query.userId,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Audit log retrieved',
        );
    }),

    /** GET /api/audit-logs/actions */
    listActions: asyncHandler(async (req, res) => {
        const actions = await auditService.listActions();
        sendSuccess(res, 'Audit actions retrieved', { actions });
    }),

    /** GET /api/audit-logs/recent */
    recent: asyncHandler(async (req, res) => {
        const activity = await auditService.recent(req.query.limit);
        sendSuccess(res, 'Recent activity retrieved', { activity });
    }),
};

export default auditController;
