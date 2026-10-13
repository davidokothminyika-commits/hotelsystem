/**
 * src/controllers/report.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for reporting endpoints.
 *
 * WHY IT EXISTS
 * The route file guards access (`requirePermission('report:read')`), so the
 * controller trusts that chain and only translates a validated query string
 * into a service call and a service result into the response envelope.
 *
 * RESPONSE SHAPE (GET /api/reports/finance)
 *   data.report.range    { from, to }                 inclusive 'YYYY-MM-DD' bounds actually used
 *   data.report.pricing  { currency, taxRate, serviceChargeRate }
 *   data.report.tax      accrual summary: totals plus a `rooms` and `food`
 *                        split of the same figures
 *   data.report.payments { collected, collectedCount, refunded, refundedCount,
 *                          net, byMethod: { card, mobile_money, cash } }
 *   data.report.daily    [{ date, invoicesIssued, invoiced, tax, collected,
 *                           refunded, net }, ...] one row per day, zeros filled
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/reporting.service.js -> repositories/report.repository.js
 * Frontend calls: public/js/pages/admin/reports.js
 */
import { sendSuccess } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import reportingService from '../services/reporting.service.js';

const reportController = {
    /** GET /api/reports/finance */
    finance: asyncHandler(async (req, res) => {
        const report = await reportingService.getFinanceReport({
            from: req.query.from,
            to: req.query.to,
        });

        return sendSuccess(res, 'Finance report retrieved', { report });
    }),
};

export default reportController;
