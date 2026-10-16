/**
 * src/repositories/rate.repository.js
 *
 * WHAT THIS MODULE DOES
 * All SQL for rate rules, the rows the dynamic pricing engine evaluates on
 * top of a room's base price.
 *
 * WHY RULES LIVE IN A TABLE AND NOT IN CODE
 * A hotel republishes its pricing constantly - a festival week, a conference
 * discount, a quiet-month offer. Each is data, not a deploy.
 *
 * COMMUNICATION
 * Called by: services/rate.service.js
 * Database tables used: rate_rules, room_types, users
 * Frontend: /api/rates
 */
import { query, queryOne, execute } from '../config/db.js';
import { resolveSort } from './base.repository.js';

const RULE_SELECT = `
    SELECT r.*,
           rt.name AS room_type_name,
           CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
    FROM rate_rules r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN users u ON u.id = r.created_by`;

/**
 * mysql2 returns a SET column as a comma-joined string. The engine wants an
 * array, and this keeps the two shapes from leaking into each other.
 */
function mapRule(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        roomTypeId: row.room_type_id ?? null,
        roomTypeName: row.room_type_name ?? null,
        triggerType: row.trigger_type,
        startDate: row.start_date ?? null,
        endDate: row.end_date ?? null,
        daysOfWeek: row.days_of_week
            ? row.days_of_week.split(',').filter(Boolean)
            : [],
        occupancyThreshold:
            row.occupancy_threshold === null || row.occupancy_threshold === undefined
                ? null
                : Number(row.occupancy_threshold),
        adjustmentType: row.adjustment_type,
        adjustmentValue: Number(row.adjustment_value),
        priority: Number(row.priority),
        isActive: Number(row.is_active) === 1,
        createdBy: row.created_by ?? null,
        createdByName: row.created_by_name ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** The allowed sort columns; anything else falls back to priority, name. */
const SORTABLE_RULE_COLUMNS = ['r.priority', 'r.name', 'r.created_at', 'r.trigger_type'];

const rateRepository = {
    /**
     * Every currently active rule, cheapest evaluation first.
     * Rules are read in one shot by the pricing engine, which then matches
     * them in memory: the whole table is realistically dozens of rows, and the
     * match logic is date arithmetic better done in code.
     */
    async findActiveRules() {
        const rows = await query(
            `${RULE_SELECT} WHERE r.is_active = 1 ORDER BY r.priority ASC, r.id ASC`,
        );
        return rows.map(mapRule);
    },

    async findById(id) {
        const row = await queryOne(`${RULE_SELECT} WHERE r.id = :id`, { id });
        return mapRule(row);
    },

    async findByName(name) {
        const row = await queryOne(`${RULE_SELECT} WHERE r.name = :name`, { name });
        return mapRule(row);
    },

    async findMany({ page = 1, limit = 50, triggerType, isActive, search, sortBy, sortDir }) {
        const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
        const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
        const params = { limit: safeLimit, offset: (safePage - 1) * safeLimit };

        const conditions = [];
        if (triggerType) {
            conditions.push({ sql: 'r.trigger_type = :triggerType', params: { triggerType } });
        }
        if (isActive === true || isActive === false) {
            conditions.push({ sql: 'r.is_active = :isActive', params: { isActive: isActive ? 1 : 0 } });
        }
        if (search) {
            conditions.push({
                sql: 'r.name LIKE :search',
                params: { search: `%${search}%` },
            });
        }

        const where = conditions.length
            ? `WHERE ${conditions.map((c) => c.sql).join(' AND ')}`
            : '';
        const filterParams = Object.assign({}, ...conditions.map((c) => c.params ?? {}));
        const sort = resolveSort(sortBy, sortDir, SORTABLE_RULE_COLUMNS, 'r.priority', 'ASC');

        const rows = await query(
            `${RULE_SELECT}
             ${where}
             ORDER BY ${sort.column} ${sort.direction}, r.id ASC
             LIMIT :limit OFFSET :offset`,
            Object.assign({}, filterParams, params),
        );

        const countRow = await queryOne(`SELECT COUNT(*) AS total FROM rate_rules r ${where}`, filterParams);

        return {
            rows: rows.map(mapRule),
            total: countRow ? Number(countRow.total) : 0,
            page: safePage,
            limit: safeLimit,
        };
    },

    async create(data) {
        const result = await execute(
            `INSERT INTO rate_rules
                (name, room_type_id, trigger_type, start_date, end_date, days_of_week,
                 occupancy_threshold, adjustment_type, adjustment_value, priority, is_active, created_by)
             VALUES
                (:name, :roomTypeId, :triggerType, :startDate, :endDate, :daysOfWeek,
                 :occupancyThreshold, :adjustmentType, :adjustmentValue, :priority, :isActive, :createdBy)`,
            {
                name: data.name,
                roomTypeId: data.roomTypeId ?? null,
                triggerType: data.triggerType || 'date_range',
                startDate: data.startDate ?? null,
                endDate: data.endDate ?? null,
                daysOfWeek: Array.isArray(data.daysOfWeek) && data.daysOfWeek.length > 0
                    ? data.daysOfWeek.join(',')
                    : null,
                occupancyThreshold: data.occupancyThreshold ?? null,
                adjustmentType: data.adjustmentType || 'percent',
                adjustmentValue: data.adjustmentValue,
                priority: data.priority ?? 100,
                isActive: data.isActive === false ? 0 : 1,
                createdBy: data.createdBy ?? null,
            },
        );
        return result.insertId;
    },

    async update(id, data) {
        await execute(
            `UPDATE rate_rules SET
                name = COALESCE(:name, name),
                room_type_id = COALESCE(:roomTypeId, room_type_id),
                trigger_type = COALESCE(:triggerType, trigger_type),
                start_date = COALESCE(:startDate, start_date),
                end_date = COALESCE(:endDate, end_date),
                days_of_week = COALESCE(:daysOfWeek, days_of_week),
                occupancy_threshold = COALESCE(:occupancyThreshold, occupancy_threshold),
                adjustment_type = COALESCE(:adjustmentType, adjustment_type),
                adjustment_value = COALESCE(:adjustmentValue, adjustment_value),
                priority = COALESCE(:priority, priority),
                is_active = COALESCE(:isActive, is_active)
             WHERE id = :id`,
            {
                id,
                name: data.name ?? null,
                roomTypeId: data.roomTypeId ?? null,
                triggerType: data.triggerType ?? null,
                startDate: data.startDate ?? null,
                endDate: data.endDate ?? null,
                daysOfWeek: Array.isArray(data.daysOfWeek) && data.daysOfWeek.length > 0
                    ? data.daysOfWeek.join(',')
                    : null,
                occupancyThreshold: data.occupancyThreshold ?? null,
                adjustmentType: data.adjustmentType ?? null,
                adjustmentValue: data.adjustmentValue ?? null,
                priority: data.priority ?? null,
                // A rule is rarely re-enabled by accident, so deactivating is
                // always an explicit PATCH here rather than a silent default.
                isActive: data.isActive === undefined ? null : (data.isActive ? 1 : 0),
            },
        );
    },

    async remove(id) {
        await execute('DELETE FROM rate_rules WHERE id = :id', { id });
    },
};

export default rateRepository;
