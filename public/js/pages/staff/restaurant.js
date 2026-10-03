/**
 * public/js/pages/staff/restaurant.js
 *
 * WHAT THIS MODULE DOES
 * The kitchen order board: live orders grouped into the columns they are in, with
 * the next action on each ticket.
 *
 * WHY IT EXISTS
 * A kitchen works a queue. The order's next step is the only thing that matters,
 * so the board is organised by status rather than by time, and the button on a
 * ticket is the step that moves it to the next column.
 *
 * WHY EACH COLUMN IS CAPPED
 * The seeded database holds hundreds of pending orders from the test suite. A
 * column that renders every one of them is unusable and slow, so each column
 * shows the oldest tickets first: those are the ones that have been waiting
 * longest, and in a real kitchen age is the priority.
 *
 * COMMUNICATION
 * Page -> GET   /api/orders/board   (all open columns in one request)
 *      -> PATCH /api/orders/:id/status
 * Database tables used: orders, order_items, menu_items, users, rooms
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { confirmAndRun } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    formatMoney,
    formatDate,
    statusLabel,
} from '../../lib/dom.js';

const STAFF_ROLES = ['restaurant_staff', 'manager', 'admin'];

/** The columns in workflow order, with the action that advances a ticket. */
const COLUMNS = [
    { key: 'pending', label: 'New', icon: 'fa-bell', next: 'confirmed', nextLabel: 'Accept' },
    { key: 'confirmed', label: 'Accepted', icon: 'fa-thumbs-up', next: 'preparing', nextLabel: 'Start cooking' },
    { key: 'preparing', label: 'Preparing', icon: 'fa-fire-burner', next: 'ready', nextLabel: 'Mark ready' },
    { key: 'ready', label: 'Ready', icon: 'fa-bell-concierge', next: 'out_for_delivery', nextLabel: 'Hand over' },
    { key: 'out_for_delivery', label: 'Out', icon: 'fa-truck-fast', next: 'delivered', nextLabel: 'Mark delivered' },
];

/** Orders shown per column before the "show more" link. */
const PER_COLUMN = 12;

const shell = await buildShell({
    title: 'Order board',
    subtitle: 'Live kitchen queue',
    roles: STAFF_ROLES,
});

if (shell?.content) {
    const { content } = shell;

    const bar = createElement('div', {
        class: 'flex flex-wrap items-center justify-between gap-3 mb-4',
    });
    const status = createElement('p', { class: 'text-sm text-stone-500', text: 'Loading orders...' });
    bar.append(status);

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

    content.append(bar);

    const board = createElement('div', {
        class: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start',
    });
    content.appendChild(board);

    // =====================================================================
    // Data
    // =====================================================================

    async function load() {
        showSkeleton(board, COLUMNS.length, 'h-64');

        try {
            const result = await api.get('/orders/board');
            const data = result?.data || {};
            const columns = data.columns || {};

            clear(board);

            const active = COLUMNS.filter((column) => (columns[column.key] || []).length > 0);

            if (active.length === 0) {
                board.appendChild(
                    createElement('div', {
                        class: 'col-span-full bg-white rounded-xl border border-stone-200 shadow-sm',
                    }),
                );
                const holder = board.firstChild;
                holder.appendChild(
                    createElement('div', { class: 'text-center py-12 text-stone-500' }, [
                        createElement('i', { class: 'fa-solid fa-utensils text-3xl text-stone-300 mb-3 block', 'aria-hidden': 'true' }),
                        createElement('p', { class: 'font-medium text-stone-900', text: 'No open orders' }),
                        createElement('p', { class: 'text-sm', text: 'New orders will appear here as guests place them.' }),
                    ]),
                );
                status.textContent = 'Nothing in the queue.';
                return;
            }

            let total = 0;
            for (const column of COLUMNS) {
                const orders = columns[column.key] || [];
                total += orders.length;
                board.appendChild(columnPanel(column, orders));
            }

            status.textContent = `${total} open order${total === 1 ? '' : 's'}`;
        } catch (error) {
            clear(board);
            status.textContent = 'Could not load the order board.';
            const panel = createElement('div', { class: 'col-span-full bg-white rounded-xl border border-stone-200 p-4' }, [
                createElement('p', { class: 'text-sm text-red-600', text: error.message }),
            ]);
            board.appendChild(panel);
        }
    }

    function columnPanel(column, orders) {
        const body = createElement('div', { class: 'p-2 space-y-2' });

        const head = createElement('header', {
            class: 'px-3 py-2 border-b border-stone-200 flex items-center justify-between gap-2 sticky top-0 bg-white rounded-t-xl',
        }, [
            createElement('div', { class: 'flex items-center gap-2 min-w-0' }, [
                createElement('i', { class: `fa-solid ${column.icon} text-stone-400`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900 text-sm truncate', text: column.label }),
            ]),
            createElement('span', { class: 'badge badge-neutral', text: String(orders.length) }),
        ]);

        const card = createElement('section', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden',
        }, [head, body]);

        const visible = orders.slice(0, PER_COLUMN);

        for (const order of visible) {
            body.appendChild(ticket(order, column));
        }

        if (orders.length > visible.length) {
            body.appendChild(
                createElement('p', {
                    class: 'text-xs text-stone-500 text-center py-2',
                    text: `+${orders.length - visible.length} older order${orders.length - visible.length === 1 ? '' : 's'}`,
                }),
            );
        }

        return card;
    }

    function ticket(order, column) {
        const card = createElement('article', { class: 'border border-stone-200 rounded-lg p-3' });

        const top = createElement('div', { class: 'flex items-start justify-between gap-2 mb-1' });
        top.append(
            createElement('span', {
                class: 'font-mono text-xs text-stone-500',
                text: order.orderReference,
            }),
            createElement('span', {
                class: 'text-xs font-medium text-stone-900',
                text: formatMoney(order.totalAmount),
            }),
        );
        card.appendChild(top);

        card.appendChild(
            createElement('p', {
                class: 'text-sm text-stone-700 mb-1',
                text: order.guestName || 'Guest',
            }),
        );

        const fulfilment = createElement('p', { class: 'text-xs text-stone-500 mb-2' });
        fulfilment.textContent =
            order.fulfilmentType === 'room_delivery'
                ? `Deliver to room ${order.roomNumber ?? '-'}`
                : 'Restaurant pickup';
        card.appendChild(fulfilment);

        // Line items, so the kitchen does not have to open the order to read it.
        const items = createElement('ul', { class: 'text-xs text-stone-700 space-y-0.5 mb-2' });
        for (const item of order.items || []) {
            const line = createElement('li', { class: 'flex justify-between gap-2' });
            line.append(
                createElement('span', { text: `${item.quantity} x ${item.name}` }),
                createElement('span', { class: 'text-stone-500', text: formatMoney(item.lineTotal) }),
            );
            items.appendChild(line);

            if (item.specialInstructions) {
                items.appendChild(
                    createElement('li', {
                        class: 'text-amber-700 italic',
                        text: `   ${item.specialInstructions}`,
                    }),
                );
            }
        }
        card.appendChild(items);

        card.appendChild(
            createElement('p', {
                class: 'text-[11px] text-stone-400 mb-2',
                text: `Placed ${formatDate(order.placedAt || order.createdAt)}`,
            }),
        );

        card.appendChild(
            createElement('button', {
                type: 'button',
                class: 'btn btn-primary btn-sm w-full',
                html: `<i class="fa-solid fa-arrow-right" aria-hidden="true"></i> ${column.nextLabel}`,
                onclick: () => advance(order, column),
            }),
        );

        return card;
    }

    async function advance(order, column) {
        const done = await confirmAndRun({
            title: `${column.nextLabel}?`,
            message: `Order ${order.orderReference} will move to "${statusLabel(column.next)}".`,
            confirmLabel: column.nextLabel,
            variant: 'primary',
            run: () => api.patch(`/orders/${order.id}/status`, { status: column.next }),
        });

        if (done) {
            notify.success(`Order ${order.orderReference} is now ${statusLabel(column.next)}.`);
            load();
        }
    }

    await load();
}
