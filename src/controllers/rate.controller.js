/**
 * src/controllers/rate.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for dynamic pricing: the rule list a manager maintains and the
 * quote endpoint the front desk and booking flow use.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/rate.service.js
 * Frontend: public/js/pages/admin/rates.js
 */
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import rateService from '../services/rate.service.js';

const rateController = {
    /** GET /api/rates */
    list: asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const result = await rateService.listRules({
            page: query.page,
            limit: query.limit,
            triggerType: query.triggerType,
            isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
            search: query.search,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });

        return sendPaginated(
            res,
            result.rows,
            { page: result.page, limit: result.limit, total: result.total },
            'Rate rules retrieved',
        );
    }),

    /** POST /api/rates */
    create: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const rule = await rateService.createRule(payload, req.user);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.RATE_RULE_CREATED,
            entity: 'rate_rules',
            entityId: rule.id,
            req,
            metadata: { rule_name: rule.name, trigger: rule.triggerType },
        });

        return sendCreated(res, 'Rate rule created', { rule });
    }),

    /** GET /api/rates/:id */
    detail: asyncHandler(async (req, res) => {
        const rule = await rateService.getRule(req.params.id);
        return sendSuccess(res, 'Rate rule retrieved', { rule });
    }),

    /** PATCH /api/rates/:id */
    update: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const rule = await rateService.updateRule(req.params.id, payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.RATE_RULE_UPDATED,
            entity: 'rate_rules',
            entityId: rule.id,
            req,
            metadata: {
                rule_name: rule.name,
                changes: Object.keys(payload),
            },
        });

        return sendSuccess(res, 'Rate rule updated', { rule });
    }),

    /** DELETE /api/rates/:id */
    remove: asyncHandler(async (req, res) => {
        const rule = await rateService.deleteRule(req.params.id);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.RATE_RULE_DELETED,
            entity: 'rate_rules',
            entityId: req.params.id,
            req,
            metadata: { rule_name: rule.name },
        });

        return sendSuccess(res, 'Rate rule deleted', { rule });
    }),

    /**
     * GET /api/rates/quote?roomId=&checkIn=&checkOut=
     * The resolved price for one stay of one room, with every rule that moved it.
     */
    quote: asyncHandler(async (req, res) => {
        const query = req.validated?.query || req.query;

        const quote = await rateService.quote({
            roomId: query.roomId,
            checkIn: query.checkIn,
            checkOut: query.checkOut,
        });

        return sendSuccess(res, 'Quote resolved', { quote });
    }),
};

export default rateController;
