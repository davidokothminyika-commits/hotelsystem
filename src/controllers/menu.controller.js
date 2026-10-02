/**
 * src/controllers/menu.controller.js
 *
 * WHAT THIS MODULE DOES
 * HTTP handlers for the restaurant menu.
 *
 * COMMUNICATION
 * Routes -> THIS FILE -> services/menu.service.js -> menu.repository.js
 * Frontend: public/js/api/menu.js
 */
import { sendSuccess, sendPaginated, sendCreated } from '../utils/response.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { recordAudit } from '../middleware/audit.middleware.js';
import { AUDIT_ACTIONS } from '../services/audit.service.js';
import { toStoredPath } from '../middleware/upload.middleware.js';
import menuService from '../services/menu.service.js';

const menuController = {
    /**
     * GET /api/menu/categories
     * Declared before /:id so the literal path is not treated as an id.
     */
    categories: asyncHandler(async (req, res) => {
        // Staff need inactive categories too, for menu administration.
        const includeInactive = req.user && req.user.role !== 'guest' && req.query.includeInactive === 'true';
        const categories = await menuService.listCategories({ includeInactive });
        return sendSuccess(res, 'Menu categories retrieved', { categories });
    }),

    /**
     * GET /api/menu
     * A guest sees available items only; the service enforces that.
     */
    browse: asyncHandler(async (req, res) => {
        const result = await menuService.browseMenu({
            user: req.user,
            search: req.query.search,
            categoryId: req.query.category,
            categorySlug: req.query.categorySlug,
            vegetarian: req.query.vegetarian,
            spicy: req.query.spicy,
            featured: req.query.featured,
            maxPrice: req.query.maxPrice,
            page: req.query.page,
            limit: req.query.limit,
            sortBy: req.query.sortBy,
            sortDir: req.query.sortDir,
        });

        return sendPaginated(
            res,
            result.items,
            { page: result.page, limit: result.limit, total: result.total },
            result.total === 0 ? 'No dishes match your search' : `${result.total} dish(es) available`,
        );
    }),

    /** GET /api/menu/stats */
    stats: asyncHandler(async (req, res) => {
        const stats = await menuService.getStats();
        return sendSuccess(res, 'Menu statistics retrieved', { stats });
    }),

    /** GET /api/menu/popular */
    popular: asyncHandler(async (req, res) => {
        const items = await menuService.getPopularItems({
            limit: req.query.limit,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        });
        return sendSuccess(res, 'Popular items retrieved', { items });
    }),

    /** GET /api/menu/:id */
    detail: asyncHandler(async (req, res) => {
        const item = await menuService.getItem(req.params.id);
        return sendSuccess(res, 'Menu item retrieved', { item });
    }),

    // -------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------

    /** POST /api/menu */
    create: asyncHandler(async (req, res) => {
        const payload = { ...(req.validated?.body || req.body) };

        // multer has already stored the file under a generated name.
        if (req.file) {
            payload.image = toStoredPath(req.file);
        }

        const item = await menuService.createItem(payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MENU_ITEM_CREATED,
            entity: 'menu_items',
            entityId: item.id,
            req,
            metadata: { name: item.name, price: item.price },
        });

        return sendCreated(res, 'Menu item created', { item });
    }),

    /** PATCH /api/menu/:id */
    update: asyncHandler(async (req, res) => {
        const payload = { ...(req.validated?.body || req.body) };

        if (req.file) {
            payload.image = toStoredPath(req.file);
        }

        const item = await menuService.updateItem(req.params.id, payload);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MENU_ITEM_UPDATED,
            entity: 'menu_items',
            entityId: item.id,
            req,
            metadata: { changes: Object.keys(payload) },
        });

        return sendSuccess(res, 'Menu item updated', { item });
    }),

    /** PATCH /api/menu/:id/availability */
    setAvailability: asyncHandler(async (req, res) => {
        const payload = req.validated?.body || req.body;
        const item = await menuService.setAvailability(req.params.id, payload.isAvailable);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MENU_ITEM_UPDATED,
            entity: 'menu_items',
            entityId: item.id,
            req,
            metadata: { is_available: payload.isAvailable },
        });

        return sendSuccess(
            res,
            payload.isAvailable ? 'Item is back on the menu' : 'Item marked as sold out',
            { item },
        );
    }),

    /** DELETE /api/menu/:id */
    remove: asyncHandler(async (req, res) => {
        const result = await menuService.removeItem(req.params.id);

        await recordAudit({
            userId: req.user.id,
            action: AUDIT_ACTIONS.MENU_ITEM_DELETED,
            entity: 'menu_items',
            entityId: req.params.id,
            req,
            metadata: result,
        });

        return sendSuccess(
            res,
            result.deleted
                ? 'Menu item deleted'
                : 'Item appears on past orders, so it was marked sold out instead of deleted',
            result,
        );
    }),
};

export default menuController;