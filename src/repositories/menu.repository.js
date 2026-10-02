/**
 * src/repositories/menu.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for menu categories and menu items.
 *
 * WHY IT EXISTS
 * The restaurant menu is read far more often than it is written: every guest
 * opening the menu page runs a filtered, paginated query. Keeping it here
 * means the search, filter and availability logic can be tuned in one place.
 *
 * COMMUNICATION
 * Called by: services/menu.service.js, services/order.service.js
 * Database tables used: menu_categories, menu_items
 * Frontend access: /api/menu, /api/menu/categories
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolvePagination, resolveSort, buildInClause } from './base.repository.js';

const SORTABLE_ITEM_COLUMNS = ['mi.name', 'mi.price', 'mi.created_at', 'mi.prep_minutes'];

function mapItem(row) {
    if (!row) return null;
    return {
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name,
        categorySlug: row.category_slug,
        name: row.name,
        description: row.description,
        price: Number(row.price),
        image: row.image,
        isVeg: Boolean(row.is_vegetarian),
        isSpicy: Boolean(row.is_spicy),
        isFeatured: Boolean(row.is_featured),
        // A sold out item is hidden from ordering but stays visible on the
        // menu, so a guest is not told a dish exists only to find it missing.
        isAvailable: Boolean(row.is_available),
        prepMinutes: row.prep_minutes,
    };
}

const menuRepository = {
    /**
     * Lists menu items with search and filters.
     *
     * SEARCH IS PARAMETERISED. The LIKE pattern is a bound value, so a search
     * for `'; DROP TABLE menu_items; --` is matched literally and cannot
     * reach the SQL text.
     */
    async findItems({
        page = 1,
        limit = 24,
        search,
        categoryId,
        categorySlug,
        vegetarian,
        spicy,
        availableOnly,
        maxPrice,
        featured,
        sortBy,
        sortDir,
    }) {
        const pagination = resolvePagination({ page, limit });
        const conditions = [];
        const params = { limit: pagination.limit, offset: pagination.offset };

        // The admin menu needs to see sold out items; the guest menu does not.
        if (availableOnly !== false) {
            conditions.push({ sql: 'mi.is_available = 1', params: {} });
        }

        if (search) {
            conditions.push({
                sql: '(mi.name LIKE :search OR mi.description LIKE :search)',
                params: { search: `%${search}%` },
            });
        }
        if (categoryId) {
            conditions.push({ sql: 'mi.category_id = :categoryId', params: { categoryId: Number(categoryId) } });
        }
        if (categorySlug) {
            conditions.push({ sql: 'mc.slug = :categorySlug', params: { categorySlug } });
        }
        if (vegetarian) {
            conditions.push({ sql: 'mi.is_vegetarian = 1', params: {} });
        }
        if (spicy) {
            conditions.push({ sql: 'mi.is_spicy = 1', params: {} });
        }
        if (featured) {
            conditions.push({ sql: 'mi.is_featured = 1', params: {} });
        }
        if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
            conditions.push({ sql: 'mi.price <= :maxPrice', params: { maxPrice: Number(maxPrice) } });
        }

        const where = conditions.length ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        const sort = resolveSort(sortBy, sortDir, SORTABLE_ITEM_COLUMNS, 'mc.sort_order', 'ASC');

        /**
         * When the caller asks for a specific sort, it applies across the
         * whole result. Otherwise dishes are grouped by category in menu
         * order, which is how a menu is naturally read.
         *
         * Sorting by price while still grouping by category would return
         * groups that each happen to be sorted, which is not what "sort by
         * price" means to the person asking for it.
         */
        const hasExplicitSort = SORTABLE_ITEM_COLUMNS.includes(sortBy);
        const orderBy = hasExplicitSort
            ? `${sort.column} ${sort.direction}, mc.sort_order ASC`
            : `mc.sort_order ASC, mi.name ASC`;

        const rows = await query(
            `SELECT mi.*, mc.name AS category_name, mc.slug AS category_slug
             FROM menu_items mi
             JOIN menu_categories mc ON mc.id = mi.category_id
             ${where}
             ORDER BY ${orderBy}
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(
            `SELECT COUNT(*) AS total
             FROM menu_items mi
             JOIN menu_categories mc ON mc.id = mi.category_id
             ${where}`,
            filterParams,
        );

        return { rows: rows.map(mapItem), total: countRow ? Number(countRow.total) : 0 };
    },

    /** Single item. */
    async findItemById(id) {
        const row = await queryOne(
            `SELECT mi.*, mc.name AS category_name, mc.slug AS category_slug
             FROM menu_items mi
             JOIN menu_categories mc ON mc.id = mi.category_id
             WHERE mi.id = :id`,
            { id },
        );
        return mapItem(row);
    },

    /**
     * Looks up several items at once by id.
     *
     * Order placement uses this so the whole cart is priced from the database
     * in one round trip, and so a client cannot dictate its own prices.
     */
    async findItemsByIds(ids) {
        if (!ids.length) return [];

        // The placeholder list is generated from the array length; every value
        // still travels as a bound parameter.
        const { placeholders, params } = buildInClause(ids, 'id');

        const rows = await query(
            `SELECT mi.*, mc.name AS category_name, mc.slug AS category_slug
             FROM menu_items mi
             JOIN menu_categories mc ON mc.id = mi.category_id
             WHERE mi.id IN (${placeholders})`,
            params,
        );
        return rows.map(mapItem);
    },

    /** Categories with an item count, for the filter tabs. */
    async listCategories({ includeInactive = false } = {}) {
        return query(
            `SELECT mc.id, mc.name, mc.slug, mc.icon, mc.sort_order,
                    (SELECT COUNT(*) FROM menu_items mi
                     WHERE mi.category_id = mc.id AND mi.is_available = 1) AS item_count
             FROM menu_categories mc
             ${includeInactive ? '' : 'WHERE mc.is_active = 1'}
             ORDER BY mc.sort_order ASC, mc.name ASC`,
        );
    },

    async findCategoryById(id) {
        return queryOne('SELECT * FROM menu_categories WHERE id = :id', { id });
    },

    async createItem({ categoryId, name, description, price, isVegetarian, isSpicy, isFeatured, isAvailable, prepMinutes, image }) {
        const result = await execute(
            `INSERT INTO menu_items
               (category_id, name, description, price, image, is_vegetarian, is_spicy, is_featured, is_available, prep_minutes)
             VALUES (:categoryId, :name, :description, :price, :image, :isVegetarian, :isSpicy, :isFeatured, :isAvailable, :prepMinutes)`,
            {
                categoryId,
                name,
                description: description || null,
                price,
                image: image || null,
                isVegetarian: isVegetarian ? 1 : 0,
                isSpicy: isSpicy ? 1 : 0,
                isFeatured: isFeatured ? 1 : 0,
                isAvailable: isAvailable === false ? 0 : 1,
                prepMinutes: prepMinutes || 15,
            },
        );
        return result.insertId;
    },

    async updateItem(id, fields) {
        await execute(
            `UPDATE menu_items SET
                category_id = COALESCE(:categoryId, category_id),
                name = COALESCE(:name, name),
                description = COALESCE(:description, description),
                price = COALESCE(:price, price),
                image = COALESCE(:image, image),
                is_vegetarian = COALESCE(:isVegetarian, is_vegetarian),
                is_spicy = COALESCE(:isSpicy, is_spicy),
                is_featured = COALESCE(:isFeatured, is_featured),
                is_available = COALESCE(:isAvailable, is_available),
                prep_minutes = COALESCE(:prepMinutes, prep_minutes)
             WHERE id = :id`,
            {
                id,
                categoryId: fields.categoryId ?? null,
                name: fields.name ?? null,
                description: fields.description ?? null,
                price: fields.price ?? null,
                image: fields.image ?? null,
                isVegetarian: fields.isVegetarian === undefined || fields.isVegetarian === null ? null : fields.isVegetarian ? 1 : 0,
                isSpicy: fields.isSpicy === undefined || fields.isSpicy === null ? null : fields.isSpicy ? 1 : 0,
                isFeatured: fields.isFeatured === undefined || fields.isFeatured === null ? null : fields.isFeatured ? 1 : 0,
                isAvailable: fields.isAvailable === undefined || fields.isAvailable === null ? null : fields.isAvailable ? 1 : 0,
                prepMinutes: fields.prepMinutes ?? null,
            },
        );
        return this.findItemById(id);
    },

    /** Marks an item sold out without deleting it. */
    async setAvailability(id, isAvailable) {
        await execute('UPDATE menu_items SET is_available = :isAvailable WHERE id = :id', {
            id,
            isAvailable: isAvailable ? 1 : 0,
        });
        return this.findItemById(id);
    },

    /**
     * Deletes an item, but only when no order references it.
     * The foreign key is ON DELETE SET NULL, so historical orders keep the
     * snapshotted name and price either way; this check simply avoids leaving
     * orphaned lines in the order history.
     */
    async deleteItem(id) {
        const used = await queryOne('SELECT COUNT(*) AS total FROM order_items WHERE menu_item_id = :id', { id });
        if (Number(used.total) > 0) {
            // Soft delete keeps the history linked and takes it off the menu.
            await execute('UPDATE menu_items SET is_available = 0 WHERE id = :id', { id });
            return { deleted: false, inOrders: Number(used.total) };
        }

        const result = await execute('DELETE FROM menu_items WHERE id = :id', { id });
        return { deleted: result.affectedRows > 0, inOrders: 0 };
    },

    /** Menu totals for the admin dashboard. */
    async getStats() {
        const totals = await queryOne(
            `SELECT COUNT(*) AS total_items,
                    SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available_items,
                    SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) AS featured_items,
                    AVG(price) AS average_price
             FROM menu_items`,
        );

        const categories = await queryOne('SELECT COUNT(*) AS total FROM menu_categories WHERE is_active = 1');

        return {
            totalItems: Number(totals?.total_items || 0),
            availableItems: Number(totals?.available_items || 0),
            featuredItems: Number(totals?.featured_items || 0),
            averagePrice: Number(totals?.average_price || 0),
            totalCategories: Number(categories?.total || 0),
        };
    },

    /** Best selling items for the reporting screen. */
    async getPopularItems({ limit = 10, startDate, endDate } = {}) {
        const conditions = ['oi.menu_item_id IS NOT NULL'];
        const params = { limit: Math.min(50, Math.max(1, Number(limit) || 10)) };

        if (startDate) {
            conditions.push('o.placed_at >= :startDate');
            params.startDate = startDate;
        }
        if (endDate) {
            conditions.push('o.placed_at <= :endDate');
            params.endDate = endDate;
        }

        return query(
            `SELECT oi.item_name,
                    SUM(oi.quantity) AS units_sold,
                    SUM(oi.line_total) AS revenue
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE ${conditions.join(' AND ')}
               AND o.status NOT IN ('cancelled')
             GROUP BY oi.item_name
             ORDER BY units_sold DESC, revenue DESC
             LIMIT :limit`,
            params,
        );
    },
};

export default menuRepository;