/**
 * public/js/pages/guest/orders.js
 *
 * WHAT THIS MODULE DOES
 * The guest's own orders: what they have ordered, what state it is in, and how
 * much they have spent.
 *
 * WHY IT EXISTS
 * A guest's question is "where is my order". So the list leads with status and
 * keeps the reference visible, and the filter is applied by the API rather than
 * by hiding rows in the browser, so the counts match the database.
 *
 * WHY CANCELLING IS LIMITED
 * Only an order the kitchen has not started can be cancelled. Once an order is
 * preparing, the food exists and staff deal with it directly. The button is
 * hidden rather than shown-and-refused, because a rejected click teaches a guest
 * that the buttons are unreliable.
 *
 * COMMUNICATION
 * Page -> GET  /api/orders/summary   (spend totals)
 *      -> GET  /api/orders           (list, filtered and paginated)
 *      -> POST /api/orders/:id/cancel
 * Database tables used: orders, order_items, menu_items
 */
import { buildShell } from '../../components/shell.js';
import { statCard, pagination } from '../../components/cards.js';
import { confirmDialog } from '../../components/modal.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    statusBadge,
    formatMoney,
    formatDate,
} from '../../lib/dom.js';

const FILTERS = [
    { value: '', label: 'All' },
    { value: 'pending', label: 'New' },
    { value: 'confirmed', label: 'Accepted' },
    { value: 'preparing', label: 'Preparing' },
    { value: 'ready', label: 'Ready' },
    { value: 'out_for_delivery', label: 'On the way' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'cancelled', label: 'Cancelled' },
];

const shell = await buildShell({
    title: 'My orders',
    subtitle: 'Your orders and their progress',
});

if (shell?.content) {
    const { content } = shell;

    const state = { status: '', page: 1, limit: 10 };

    // ---- Spend summary ----------------------------------------------------
    const statsRow = createElement('div', { class: 'grid grid-cols-3 gap-4 mb-6' });
    content.appendChild(statsRow);

    // ---- Filters ----------------------------------------------------------
    const filterBar = createElement('div', { class: 'flex flex-wrap gap-2 mb-6' });
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter orders by status');

    for (const filter of FILTERS) {
        filterBar.appendChild(
            createElement('button', {
                type: 'button',
                class: filter.value === state.status ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
                text: filter.label,
                'aria-pressed': String(filter.value === state.status),
                'data-filter': filter.value,
                onclick: () => {
                    state.status = filter.value;
                    state.page = 1;
                    highlightFilter();
                    load();
                },
            }),
        );
    }
    content.appendChild(filterBar);

    function highlightFilter() {
        for (const button of filterBar.querySelectorAll('[data-filter]')) {
            const active = button.dataset.filter === state.status;
            // Complete class literals only: the Tailwind CDN cannot see a class
            // name that is built at runtime.
            button.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
            button.setAttribute('aria-pressed', String(active));
        }
    }

    const list = createElement('div', { class: 'space-y-4' });
    const pagerSlot = createElement('div', { id: 'order-pagination', class: 'mt-6' });
    content.append(list, pagerSlot);

    // =====================================================================
    // Data
    // =====================================================================

    async function loadSummary() {
        try {
            const result = await api.get('/orders/summary');
            const summary = result?.data?.summary || {};

            clear(statsRow);
            statsRow.append(
                statCard({ label: 'Orders placed', value: summary.totalOrders ?? 0, icon: 'fa-receipt' }),
                statCard({
                    label: 'In progress',
                    value: summary.activeOrders ?? 0,
                    icon: 'fa-fire-burner',
                    tone: 'info',
                }),
                statCard({
                    label: 'Total spent',
                    value: formatMoney(summary.totalSpent ?? 0, summary.currency || 'USD'),
                    icon: 'fa-wallet',
                    tone: 'success',
                }),
            );
        } catch {
            // The totals are supplementary; the list is the point of the page.
            clear(statsRow);
        }
    }

    async function load() {
        showSkeleton(list, 3, 'h-32');

        try {
            const result = await api.get('/orders', {
                query: {
                    page: state.page,
                    limit: state.limit,
                    status: state.status || undefined,
                },
            });

            const orders = result?.data || [];
            const meta = result?.meta || {};

            clear(list);

            if (orders.length === 0) {
                showEmptyState(list, {
                    title: state.status ? `No ${state.status.replace('_', ' ')} orders` : 'No orders yet',
                    message: state.status
                        ? 'Try a different status filter.'
                        : 'Order room service or collect from the restaurant and it will appear here.',
                    icon: 'fa-utensils',
                    actionHtml: state.status
                        ? ''
                        : '<a href="/pages/guest/restaurant.html" class="btn btn-primary">Browse the menu</a>',
                });
                clear(pagerSlot);
                return;
            }

            for (const order of orders) {
                list.appendChild(orderCard(order));
            }

            clear(pagerSlot);
            pagerSlot.appendChild(
                pagination({
                    page: Number(meta.page) || state.page,
                    totalPages: Number(meta.totalPages) || 1,
                    total: Number(meta.total) || orders.length,
                    onChange: (page) => {
                        state.page = page;
                        load();
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    },
                }),
            );
        } catch (error) {
            clear(list);
            showEmptyState(list, {
                title: 'Could not load your orders',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function orderCard(order) {
        const card = createElement('article', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-4',
        });

        const top = createElement('div', { class: 'flex items-start justify-between gap-3 mb-2' });
        const left = createElement('div', { class: 'min-w-0' });
        left.append(
            createElement('p', { class: 'font-semibold text-stone-900', text: order.orderReference }),
            createElement('p', {
                class: 'text-xs text-stone-500',
                text: `${formatDate(order.placedAt || order.createdAt)} · ${
                    order.fulfilmentType === 'room_delivery'
                        ? `Room ${order.roomNumber ?? '-'} delivery`
                        : 'Restaurant pickup'
                }`,
            }),
        );
        top.append(left, statusBadge(order.status));
        card.appendChild(top);

        const items = createElement('ul', { class: 'text-sm text-stone-700 space-y-1 mb-3' });
        for (const item of order.items || []) {
            const row = createElement('li', { class: 'flex justify-between gap-2' });
            row.append(
                createElement('span', { text: `${item.quantity} × ${item.name}` }),
                createElement('span', { class: 'text-stone-500', text: formatMoney(item.lineTotal) }),
            );
            items.appendChild(row);
        }
        card.appendChild(items);

        const footer = createElement('div', { class: 'flex items-center justify-between gap-3 pt-2 border-t border-stone-100' });
        footer.appendChild(
            createElement('span', {
                class: 'font-semibold text-stone-900',
                text: formatMoney(order.totalAmount),
            }),
        );

        const actions = createElement('div', { class: 'flex items-center gap-2' });
        actions.appendChild(
            createElement('a', {
                href: `/pages/guest/order-details.html?id=${order.id}`,
                class: 'btn btn-ghost btn-sm',
                text: 'Details',
            }),
        );

        // Only an order the kitchen has not begun can be withdrawn.
        if (order.status === 'pending') {
            actions.appendChild(
                createElement('button', {
                    type: 'button',
                    class: 'btn btn-outline btn-sm',
                    text: 'Cancel',
                    onclick: () => cancelOrder(order),
                }),
            );
        }
        footer.appendChild(actions);

        card.appendChild(footer);
        return card;
    }

    async function cancelOrder(order) {
        const confirmed = await confirmDialog({
            title: 'Cancel this order?',
            message: `Order ${order.orderReference} will be withdrawn. This cannot be undone.`,
            confirmLabel: 'Yes, cancel it',
            variant: 'danger',
        });

        if (!confirmed) return;

        try {
            await api.post(`/orders/${order.id}/cancel`, { reason: 'Cancelled by the guest' });
            notify.success('Order cancelled.');
            load();
            loadSummary();
        } catch (error) {
            notify.error(error.message);
        }
    }

    await Promise.all([loadSummary(), load()]);
}
