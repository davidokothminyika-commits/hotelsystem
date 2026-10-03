/**
 * public/js/pages/admin/reports.js
 *
 * WHAT THIS MODULE DOES
 * Operational reporting: revenue and order mix, room occupancy, the most
 * popular dishes and the booking status breakdown, with a CSV export.
 *
 * WHY EVERY FIGURE COMES FROM AN AGGREGATE ENDPOINT
 * None of these numbers are computed from a paginated list. Totalling the
 * twenty rows the browser happens to have loaded and calling the result
 * "revenue" produces a confidently wrong answer, so each figure is read from
 * the endpoint that asked the database to aggregate it.
 *
 * WHY THE CSV EXPORT IS BUILT IN THE BROWSER
 * The data is already on the page, so there is nothing to fetch and no new
 * endpoint to secure. The file is produced from the same figures that are
 * displayed, which means the export can never disagree with the screen.
 *
 * COMMUNICATION
 * Page -> GET /api/orders/sales        (revenue, order mix)
 *      -> GET /api/orders/counts       (order status breakdown)
 *      -> GET /api/rooms/status-counts (occupancy)
 *      -> GET /api/bookings/counts     (booking status breakdown)
 *      -> GET /api/menu/popular        (best sellers)
 * Database tables used: orders, order_items, rooms, bookings, menu_items
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { statCard } from '../../components/cards.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatMoney,
    formatNumber,
    formatRating,
} from '../../lib/dom.js';

const ROLES = ['manager', 'admin'];

const shell = await buildShell({
    title: 'Reports',
    subtitle: 'Revenue, occupancy and performance',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    /** Everything currently on screen, kept for the CSV export. */
    let report = {};

    addHeaderAction({
        label: 'Export CSV',
        icon: 'fa-download',
        onClick: () => exportCsv(),
    });

    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    const grid = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' });
    content.appendChild(grid);

    function panel(title, icon, body) {
        return createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: title }),
            ]),
            body,
        ]);
    }

    const revenueBody = createElement('div', { class: 'p-4' });
    const fulfilmentBody = createElement('div', { class: 'p-4' });
    const occupancyBody = createElement('div', { class: 'p-4' });
    const bookingsBody = createElement('div', { class: 'p-4' });
    const popularBody = createElement('div', { class: 'p-2' });

    grid.append(
        panel('Revenue', 'fa-sack-dollar', revenueBody),
        panel('Order mix', 'fa-chart-pie', fulfilmentBody),
        panel('Occupancy', 'fa-bed', occupancyBody),
        panel('Bookings by status', 'fa-calendar-check', bookingsBody),
    );
    grid.lastChild.append(panel('Best sellers', 'fa-utensils', popularBody));

    async function load() {
        showSkeleton(statsRow, 4, 'h-24');
        for (const body of [revenueBody, fulfilmentBody, occupancyBody, bookingsBody, popularBody]) {
            showSkeleton(body, 2, 'h-10');
        }

        const [sales, orderCounts, roomCounts, bookingCounts, popular, reviews] = await Promise.all([
            api.get('/orders/sales').catch(() => null),
            api.get('/orders/counts').catch(() => null),
            api.get('/rooms/status-counts').catch(() => null),
            api.get('/bookings/counts').catch(() => null),
            api.get('/menu/popular').catch(() => null),
            api.get('/reviews/stats').catch(() => null),
        ]);

        report = {
            sales: sales?.data?.summary || null,
            orders: orderCounts?.data?.counts || {},
            rooms: roomCounts?.data?.counts || {},
            bookings: bookingCounts?.data?.counts || {},
            popular: popular?.data?.items || popular?.data || [],
            reviews: reviews?.data?.stats || null,
        };

        render();
    }

    function render() {
        const { sales, orders, rooms, bookings } = report;

        clear(statsRow);
        statsRow.append(
            statCard({
                label: 'Revenue',
                value: sales ? formatMoney(sales.revenue) : '-',
                hint: sales ? `${formatNumber(sales.totalOrders)} orders` : '',
                icon: 'fa-sack-dollar',
                tone: 'success',
            }),
            statCard({
                label: 'Average order',
                value: sales ? formatMoney(sales.averageOrder) : '-',
                hint: 'Across all fulfilment types',
                icon: 'fa-receipt',
                tone: 'info',
            }),
            statCard({
                label: 'Rooms occupied',
                value: formatNumber(rooms.occupied ?? 0),
                hint: `of ${formatNumber(rooms.total ?? 0)}`,
                icon: 'fa-bed',
                tone: 'warning',
            }),
            statCard({
                label: 'Average rating',
                // Filled in from the reviews endpoint when it is available.
                value: report.reviews ? formatRating(report.reviews.average) : '-',
                hint: report.reviews ? `${formatNumber(report.reviews.total)} visible reviews` : 'No reviews yet',
                icon: 'fa-star',
                tone: 'accent',
            }),
        );

        renderBreakdown(revenueBody, [
            ['Total orders', formatNumber(sales?.totalOrders ?? 0)],
            ['Total revenue', sales ? formatMoney(sales.revenue) : '-'],
            ['Average order', sales ? formatMoney(sales.averageOrder) : '-'],
        ]);

        renderBreakdown(fulfilmentBody, [
            ['Pending', formatNumber(orders.pending ?? 0)],
            ['Preparing', formatNumber(orders.preparing ?? 0)],
            ['Ready', formatNumber(orders.ready ?? 0)],
            ['Delivered', formatNumber(orders.delivered ?? 0)],
            ['Cancelled', formatNumber(orders.cancelled ?? 0)],
        ]);

        const totalRooms = Number(rooms.total || 0);
        const occupied = Number(rooms.occupied || 0);
        renderBreakdown(occupancyBody, [
            ['Total rooms', formatNumber(totalRooms)],
            ['Occupied', formatNumber(occupied)],
            ['Available', formatNumber(rooms.available ?? 0)],
            ['Cleaning', formatNumber(rooms.cleaning ?? 0)],
            ['Maintenance', formatNumber(rooms.maintenance ?? 0)],
            [
                'Occupancy rate',
                totalRooms ? `${Math.round((occupied / totalRooms) * 100)}%` : '-',
            ],
        ]);

        renderBreakdown(bookingsBody, [
            ['Pending', formatNumber(bookings.pending ?? 0)],
            ['Confirmed', formatNumber(bookings.confirmed ?? 0)],
            ['Checked in', formatNumber(bookings.checked_in ?? 0)],
            ['Checked out', formatNumber(bookings.checked_out ?? 0)],
            ['Cancelled', formatNumber(bookings.cancelled ?? 0)],
            ['Total', formatNumber(bookings.total ?? 0)],
        ]);

        renderPopular();
    }

    /** A two column label/value list. */
    function renderBreakdown(container, rows) {
        clear(container);
        for (const [label, value] of rows) {
            const row = createElement('div', { class: 'flex items-center justify-between py-1.5 border-b border-stone-100 last:border-0' });
            row.append(
                createElement('span', { class: 'text-sm text-stone-600', text: label }),
                createElement('span', { class: 'text-sm font-medium text-stone-900', text: value }),
            );
            container.appendChild(row);
        }
    }

    function renderPopular() {
        const items = Array.isArray(report.popular) ? report.popular : [];
        clear(popularBody);

        if (items.length === 0) {
            showEmptyState(popularBody, {
                title: 'No sales data',
                message: 'Best sellers appear once dishes have been ordered.',
                icon: 'fa-utensils',
            });
            return;
        }

        for (const item of items.slice(0, 10)) {
            const row = createElement('div', { class: 'flex items-center justify-between gap-3 px-2 py-2 border-b border-stone-100 last:border-0' });
            const left = createElement('div', { class: 'min-w-0' });
            left.append(
                createElement('p', { class: 'text-sm text-stone-900 truncate', text: item.name || 'Dish' }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: item.categoryName || item.category || '',
                }),
            );
            row.append(
                left,
                createElement('span', {
                    class: 'text-sm font-medium text-stone-900',
                    text: `${formatNumber(item.totalQuantity ?? item.quantity ?? 0)} sold`,
                }),
            );
            popularBody.appendChild(row);
        }
    }

    /**
     * Exports the figures already on screen.
     *
     * Built from `report` rather than refetched, so the file always matches what
     * the manager was looking at.
     */
    function exportCsv() {
        const lines = [['Metric', 'Value']];

        const push = (section, rows) => {
            lines.push([]);
            lines.push([section, '']);
            for (const [label, value] of rows) lines.push([label, value]);
        };

        const { sales, orders, rooms, bookings } = report;
        const totalRooms = Number(rooms.total || 0);
        const occupied = Number(rooms.occupied || 0);

        lines.push(['Aurelia Grand Hotel report', new Date().toISOString().slice(0, 10)]);
        push('Revenue', [
            ['Total orders', sales?.totalOrders ?? 0],
            ['Total revenue', sales?.revenue ?? 0],
            ['Average order', sales?.averageOrder ?? 0],
        ]);
        push('Occupancy', [
            ['Total rooms', totalRooms],
            ['Occupied', occupied],
            ['Available', rooms.available ?? 0],
            ['Occupancy rate %', totalRooms ? Math.round((occupied / totalRooms) * 100) : 0],
        ]);
        push('Orders', [
            ['Pending', orders.pending ?? 0],
            ['Preparing', orders.preparing ?? 0],
            ['Ready', orders.ready ?? 0],
            ['Delivered', orders.delivered ?? 0],
            ['Cancelled', orders.cancelled ?? 0],
        ]);
        push('Bookings', [
            ['Pending', bookings.pending ?? 0],
            ['Confirmed', bookings.confirmed ?? 0],
            ['Checked in', bookings.checked_in ?? 0],
            ['Checked out', bookings.checked_out ?? 0],
            ['Cancelled', bookings.cancelled ?? 0],
        ]);

        // Every cell is quoted so a comma inside a value cannot shift a column.
        const csv = lines
            .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const link = createElement('a', { href: url, download: `hotel-report-${new Date().toISOString().slice(0, 10)}.csv` });
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    await load();
}
