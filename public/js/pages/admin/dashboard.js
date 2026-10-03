/**
 * public/js/pages/admin/dashboard.js
 *
 * WHAT THIS MODULE DOES
 * The management dashboard: occupancy, revenue, what needs attention, and what
 * has just happened.
 *
 * WHY IT EXISTS
 * A manager opening this page has one question, which is whether anything needs
 * them. So the page is ordered by that: the numbers that say how the hotel is
 * doing, then the queues that are waiting on a decision, then a live activity
 * feed.
 *
 * WHY EACH NUMBER COMES FROM A DEDICATED ENDPOINT
 * Occupancy and room counts come from /rooms/status-counts and revenue from
 * /orders/sales rather than being summed in the browser from the booking list.
 * Counting rows the browser happened to have paged in produces a number that is
 * quietly wrong on any page but the first, which is worse than showing nothing.
 *
 * COMMUNICATION
 * Page -> GET /api/rooms/status-counts
 *      -> GET /api/bookings/counts
 *      -> GET /api/orders/counts
 *      -> GET /api/orders/sales
 *      -> GET /api/orders?limit=6      (recent orders)
 *      -> GET /api/audit-logs/recent   (activity feed)
 * Database tables used: rooms, bookings, orders, payments, audit_logs
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
    formatDate,
    statusBadge,
} from '../../lib/dom.js';

const ROLES = ['manager', 'admin'];

const shell = await buildShell({
    title: 'Dashboard',
    subtitle: 'How the hotel is doing today',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    addHeaderAction({
        label: 'Refresh',
        icon: 'fa-rotate',
        variant: 'outline',
        href: '#',
        onClick: (event) => {
            event.preventDefault();
            load();
        },
    });

    // ---- Headline counters -------------------------------------------------
    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    // ---- Two columns: queues on the left, activity on the right ------------
    const grid = createElement('div', { class: 'grid grid-cols-1 xl:grid-cols-3 gap-6' });
    content.appendChild(grid);

    const left = createElement('div', { class: 'xl:col-span-2 space-y-6' });
    const right = createElement('div', { class: 'space-y-6' });
    grid.append(left, right);

    // ---- Occupancy ---------------------------------------------------------
    const occupancyBody = createElement('div', { class: 'p-4' });
    left.appendChild(
        panel('fa-chart-pie', 'Room occupancy', occupancyBody),
    );

    // ---- Recent orders -----------------------------------------------------
    const ordersBody = createElement('div', { class: 'p-2' });
    left.appendChild(panel('fa-receipt', 'Latest orders', ordersBody));

    // ---- Attention queue ---------------------------------------------------
    const attentionBody = createElement('div', { class: 'p-4 space-y-2' });
    right.appendChild(panel('fa-bell', 'Needs attention', attentionBody));

    // ---- Activity ----------------------------------------------------------
    const activityBody = createElement('div', { class: 'p-2' });
    right.appendChild(panel('fa-clock-rotate-left', 'Recent activity', activityBody));

    function panel(icon, title, body) {
        return createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: title }),
            ]),
            body,
        ]);
    }

    // =====================================================================
    // Data
    // =====================================================================

    /** Fetches several endpoints, tolerating any one of them failing. */
    async function collect(paths) {
        const entries = await Promise.all(
            paths.map(async ([key, path]) => {
                try {
                    const result = await api.get(path);
                    return [key, result?.data ?? null];
                } catch {
                    // One unavailable report must not blank the whole dashboard.
                    return [key, null];
                }
            }),
        );
        return Object.fromEntries(entries);
    }

    async function load() {
        showSkeleton(statsRow, 4, 'h-24');
        for (const body of [occupancyBody, ordersBody, attentionBody, activityBody]) {
            showSkeleton(body, 2, 'h-12');
        }

        const data = await collect([
            ['roomCounts', '/rooms/status-counts'],
            ['bookingCounts', '/bookings/counts'],
            ['orderCounts', '/orders/counts'],
            ['sales', '/orders/sales'],
            ['orders', '/orders?limit=6'],
            ['activity', '/audit-logs/recent?limit=12'],
        ]);

        const { roomCounts, bookingCounts, orderCounts, sales, orders, activity } = data;

        const rooms = roomCounts?.counts || {};
        const bookings = bookingCounts?.counts || {};
        const counts = orderCounts?.counts || {};
        const revenue = sales?.summary?.revenue;

        const totalRooms = Number(rooms.total || 0);
        const occupied = Number(rooms.occupied || 0);
        const occupancyRate = totalRooms ? Math.round((occupied / totalRooms) * 100) : 0;

        clear(statsRow);
        statsRow.append(
            statCard({
                label: 'Occupancy',
                value: `${occupancyRate}%`,
                hint: `${formatNumber(occupied)} of ${formatNumber(totalRooms)} rooms`,
                icon: 'fa-bed',
                tone: 'info',
            }),
            statCard({
                label: 'Awaiting confirmation',
                value: bookings.pending ?? 0,
                hint: 'Bookings needing a decision',
                icon: 'fa-hourglass-half',
                tone: 'warning',
                href: '/pages/admin/bookings.html?status=pending',
            }),
            statCard({
                label: 'Open orders',
                value: counts.active ?? 0,
                hint: `${counts.ready ?? 0} ready to collect`,
                icon: 'fa-utensils',
                tone: 'accent',
                href: '/pages/staff/restaurant.html',
            }),
            statCard({
                label: 'Revenue',
                // The sales endpoint is unavailable to a receptionist but this
                // page is manager-only, so a miss here is a real failure and is
                // shown as a dash rather than a misleading zero.
                value: revenue === undefined ? '-' : formatMoney(revenue),
                hint: `${formatNumber(sales?.summary?.totalOrders ?? 0)} orders`,
                icon: 'fa-sack-dollar',
                tone: 'success',
            }),
        );

        renderOccupancy(rooms, occupancyRate);
        renderOrders(orders);
        renderAttention(bookings, counts, rooms);
        renderActivity(activity);
    }

    /** A stacked bar of room states, plus the counts beside it. */
    function renderOccupancy(rooms, rate) {
        clear(occupancyBody);

        const SEGMENTS = [
            { key: 'occupied', label: 'Occupied', className: 'bg-amber-600' },
            { key: 'available', label: 'Available', className: 'bg-emerald-500' },
            { key: 'cleaning', label: 'Cleaning', className: 'bg-sky-400' },
            { key: 'reserved', label: 'Reserved', className: 'bg-violet-400' },
            { key: 'maintenance', label: 'Maintenance', className: 'bg-rose-500' },
        ];

        const total = Number(rooms.total || 0) || 1;

        const bar = createElement('div', {
            class: 'flex h-3 rounded-full overflow-hidden bg-stone-100 mb-4',
            role: 'img',
            'aria-label': `Occupancy ${rate} percent`,
        });

        for (const segment of SEGMENTS) {
            const count = Number(rooms[segment.key] || 0);
            if (count === 0) continue;
            bar.appendChild(
                createElement('div', {
                    class: segment.className,
                    style: `width:${(count / total) * 100}%`,
                }),
            );
        }
        occupancyBody.appendChild(bar);

        const legend = createElement('div', { class: 'grid grid-cols-2 sm:grid-cols-3 gap-2' });
        for (const segment of SEGMENTS) {
            const item = createElement('div', { class: 'flex items-center gap-2 text-sm' });
            item.append(
                createElement('span', { class: `w-3 h-3 rounded ${segment.className}` }),
                createElement('span', { class: 'text-stone-600', text: segment.label }),
                createElement('span', { class: 'ml-auto font-medium text-stone-900', text: String(rooms[segment.key] ?? 0) }),
            );
            legend.appendChild(item);
        }
        occupancyBody.appendChild(legend);
    }

    function renderOrders(result) {
        const orders = Array.isArray(result) ? result : [];
        clear(ordersBody);

        if (orders.length === 0) {
            showEmptyState(ordersBody, {
                title: 'No orders yet',
                message: 'Guest orders will appear here.',
                icon: 'fa-receipt',
            });
            return;
        }

        for (const order of orders) {
            const row = createElement('div', {
                class: 'flex items-center justify-between gap-3 px-2 py-2 rounded-lg hover:bg-stone-50',
            });

            const left = createElement('div', { class: 'min-w-0' });
            left.append(
                createElement('p', { class: 'text-sm text-stone-900 truncate', text: order.guestName || 'Guest' }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: `${order.orderReference} · ${formatDate(order.placedAt || order.createdAt)}`,
                }),
            );

            row.append(left, statusBadge(order.status));
            ordersBody.appendChild(row);
        }
    }

    /** Only genuine queues. Anything not needing a decision stays off this list. */
    function renderAttention(bookings, orders, rooms) {
        const items = [];

        if (bookings.pending > 0) {
            items.push({
                icon: 'fa-calendar-check',
                label: 'Bookings awaiting confirmation',
                value: bookings.pending,
                href: '/pages/admin/bookings.html?status=pending',
            });
        }
        if (orders.ready > 0) {
            items.push({
                icon: 'fa-bell-concierge',
                label: 'Orders ready for collection',
                value: orders.ready,
                href: '/pages/staff/restaurant.html',
            });
        }
        if (orders.pending > 0) {
            items.push({
                icon: 'fa-bell',
                label: 'New orders to accept',
                value: orders.pending,
                href: '/pages/staff/restaurant.html',
            });
        }
        if (Number(rooms.maintenance || 0) > 0) {
            items.push({
                icon: 'fa-wrench',
                label: 'Rooms in maintenance',
                value: rooms.maintenance,
                href: '/pages/staff/housekeeping.html',
            });
        }

        clear(attentionBody);

        if (items.length === 0) {
            showEmptyState(attentionBody, {
                title: 'Nothing waiting',
                message: 'No bookings, orders or rooms need a decision right now.',
                icon: 'fa-circle-check',
            });
            return;
        }

        for (const item of items) {
            attentionBody.appendChild(
                createElement('a', {
                    href: item.href,
                    class: 'flex items-center gap-3 p-3 rounded-lg border border-stone-200 hover:bg-stone-50 transition',
                }, [
                    createElement('i', { class: `fa-solid ${item.icon} text-stone-400`, 'aria-hidden': 'true' }),
                    createElement('span', { class: 'text-sm text-stone-700 flex-1 truncate', text: item.label }),
                    createElement('span', { class: 'badge badge-warning', text: String(item.value) }),
                ]),
            );
        }
    }

    function renderActivity(result) {
        const activity = result?.activity || [];
        clear(activityBody);

        if (activity.length === 0) {
            showEmptyState(activityBody, {
                title: 'No recent activity',
                message: 'Actions taken in the system will be recorded here.',
                icon: 'fa-clock-rotate-left',
            });
            return;
        }

        for (const entry of activity) {
            const row = createElement('div', { class: 'px-2 py-2 border-b border-stone-100 last:border-0' });
            row.append(
                createElement('p', { class: 'text-sm text-stone-800 break-words', text: describeAction(entry) }),
                createElement('p', {
                    class: 'text-[11px] text-stone-400 mt-0.5',
                    text: formatDate(entry.created_at || entry.createdAt),
                }),
            );
            activityBody.appendChild(row);
        }
    }

    /** Turns a dotted action code such as 'payment.completed' into a sentence. */
    function describeAction(entry) {
        const action = String(entry.action || '').replace(/[._]/g, ' ');
        const actor = entry.user_email || 'System';
        return `${action.charAt(0).toUpperCase()}${action.slice(1)} — ${actor}`;
    }

    await load();
}
