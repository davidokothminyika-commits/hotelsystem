/**
 * src/routes/audit.routes.js
 *
 * WHAT THIS MODULE DOES
 * Administrator access to the audit log.
 *
 * WHY IT EXISTS
 * Mounted behind `requireRole('admin')` because audit metadata can contain
 * personal data, such as the email address used in a failed login. Managers
 * see operational reports; the raw trail is an administrator's tool.
 *
 * READ ONLY
 * There is deliberately no write route. An audit log that can be edited through
 * the API that reads it is not an audit log.
 *
 * COMMUNICATION
 * Browser -> /api/audit-logs/* -> audit.controller.js -> audit.service.js
 * Database tables used: audit_logs, users
 */
import { Router } from 'express';
import auditController from '../controllers/audit.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/authorization.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { listAuditRules, recentAuditRules } from '../validators/audit.validators.js';

const router = Router();

router.use(requireAuth, requireRole('admin'));

// Literal paths before the root listing so they are not treated as filters.
router.get('/actions', auditController.listActions);
router.get('/recent', validate(recentAuditRules), auditController.recent);
router.get('/', validate(listAuditRules), auditController.list);

export default router;
