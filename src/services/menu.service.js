/**
 * src/services/menu.service.js
 *
 * WHAT THIS MODULE DOES
 * Menu browsing for guests and menu administration for restaurant staff.
 *
 * WHY IT EXISTS
 * Guests see only available items; staff need to see everything, including
 * sold out dishes, so they can bring one back. That distinction is policy, so
 * it belongs here rather than in the query.
 *
 * COMMUNICATION
 * Browser -> /api/menu, /api/menu/categories -> menu.controller.js
 *        -> THIS FILE -> menu.repository.js
 * Database tables used: menu_categories, menu_items
 */
import ApiError from '../utils/errors.js';
import menuRepository from '../repositories/menu.repository.js';
import { resolvePagination } from '../repositories/base.repository.js';

const menuService = {
    /**
     * Browses the menu.
     *
     * A guest never sees unavailable items. `availableOnly` is forced on for
     * the guest-facing list regardless of what the request asked for.
     */
    async browseMenu({ user, search, categoryId, categorySlug, vegetarian, spicy, maxPrice, featured, page, limit, sortBy, sortDir }) {
        const isGuest = !user || user.role === 'guest';

        const result = await menuRepository.findItems({
            page,
            limit,
            search,
            categoryId,
            categorySlug,
            vegetarian,
            spicy,
            maxPrice,
            featured,
            sortBy,
            sortDir,
            // A guest's list is always filtered to available items.
            availableOnly: isGuest ? true : false,
        });

        return {
            items: result.rows,
            total: result.total,
            page: Number(page) || 1,
            limit: Number(limit) || 24,
        };
    },

    /** Menu categories with item counts, for the filter tabs. */
    async listCategories({ includeInactive = false } = {}) {
        const categories = await menuRepository.listCategories({ includeInactive });
        return categories.map((category) => ({
            id: category.id,
            name: category.name,
            slug: category.slug,
            icon: category.icon,
            itemCount: Number(category.item_count || 0),
        }));
    },

    async getItem(id) {
        const item = await menuRepository.findItemById(id);
        if (!item) throw ApiError.notFound('Menu item not found', 'ITEM_NOT_FOUND');
        return item;
    },

    async createItem(data) {
        const category = await menuRepository.findCategoryById(data.categoryId);
        if (!category) {
            throw ApiError.badRequest('Choose a valid menu category', 'INVALID_CATEGORY');
        }

        const id = await menuRepository.createItem(data);
        return menuRepository.findItemById(id);
    },

    async updateItem(id, data) {
        const existing = await menuRepository.findItemById(id);
        if (!existing) throw ApiError.notFound('Menu item not found', 'ITEM_NOT_FOUND');

        if (data.categoryId) {
            const category = await menuRepository.findCategoryById(data.categoryId);
            if (!category) {
                throw ApiError.badRequest('Choose a valid menu category', 'INVALID_CATEGORY');
            }
        }

        return menuRepository.updateItem(id, data);
    },

    /** Marks an item sold out or back in stock. */
    async setAvailability(id, isAvailable) {
        const existing = await menuRepository.findItemById(id);
        if (!existing) throw ApiError.notFound('Menu item not found', 'ITEM_NOT_FOUND');

        return menuRepository.setAvailability(id, isAvailable);
    },

    /**
     * Removes an item.
     *
     * If the item appears on past orders it is marked sold out instead of
     * deleted, so the order history keeps a link to a real menu record while
     * the guest-facing menu no longer offers it.
     */
    async removeItem(id) {
        const existing = await menuRepository.findItemById(id);
        if (!existing) throw ApiError.notFound('Menu item not found', 'ITEM_NOT_FOUND');

        return menuRepository.deleteItem(id);
    },

    async getStats() {
        return menuRepository.getStats();
    },

    async getPopularItems(options) {
        return menuRepository.getPopularItems(options);
    },
};

export default menuService;