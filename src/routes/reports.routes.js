/**
 * src/routes/reports.routes.js
 *
 * WHAT THIS MODULE DOES
 * Reporting endpoints, starting with the finance report (tax summary and
 * daily revenue audit).
 *
 * WHY THE GUARD IS A PERMISSION, NOT A ROLE
 * `report:read` is the permission the role catalogue already defines for
 * exactly this kind of figure. Gating on it means a manager sees the finance
 * report the reports page offers them, a receptionist does not, and an
 * administrator always does - all decided in one place (role_permissions)
 * rather than in a role list that drifts out of step with the seed data.
 *
 * COMMUNICATION
 * Frontend (public/js/pages/admin/reports.js) -> THIS FILE
 *      -> report.controller.js -> services/reporting.service.js
 * Database tables used: invoices, payments (read only).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requirePermission } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { financeReportRules } from '../validators/report.validators.js';
import reportController from '../controllers/report.controller.js';

const router = Router();

// Declared once for the whole file: requirePermission reads req.user, which
// only requireAuth populates, and a new route added below is protected the
// moment it exists.
router.use(requireAuth, requirePermission('report:read'));

// Literal paths would come before '/:id' here, but this router declares no
// parameterised routes, so the single root-style path is unambiguous.
router.get('/finance', validate(financeReportRules, 'query'), reportController.finance);

export default router;
