/**
 * public/js/pages/guest/order-details.js
 *
 * WHAT THIS MODULE DOES
 * One order in full: the items, what it cost, where it is going and what has
 * happened to it.
 *
 * WHY IT IS A SEPARATE PAGE
 * The list has to stay scannable, so it shows a summary per order. This page is
 * where the line items and the price breakdown are spelled out, which is what a
 * guest disputes.
 *
 * WHY THE STATUS IS SHOWN AS STEPS
 * An order's status is a sequence, not a label. Laying the steps out in order
 * makes "preparing" meaningful: the guest can see it is on its way to "ready"
 * rather than simply being told it is not finished.
 *
 * COMMUNICATION
 * Page -> GET  /api/orders/:id
 * Database tables used: orders, order_items, menu_items, users, rooms
 */
import { buildShell } from '../../components/shell.js';
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
    getQueryParam,
} from '../../lib/dom.js';

/** The order lifecycle, in order. */
const STEPS = [
    { key: 'pending', label: 'Received' },
    { key: 'confirmed', label: 'Accepted' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
    { key: 'out_for_delivery', label: 'Out for delivery' },
    { key: 'delivered', label: 'Delivered' },
];

const shell = await buildShell({
    title: 'Order details',
    subtitle: '',
});

if (shell?.content) {
    const { content } = shell;

    const back = createElement('a', {
        href: '/pages/guest/orders.html',
        class: 'inline-flex items-center gap-2 text-sm text-stone-600 hover:text-stone-900 mb-4',
    });
    back.append(
        createElement('i', { class: 'fa-solid fa-arrow-left', 'aria-hidden': 'true' }),
        createElement('span', { text: 'Back to my orders' }),
    );
    content.appendChild(back);

    const panel = createElement('div', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' });
    content.appendChild(panel);

    const id = getQueryParam('id');

    async function load() {
        showSkeleton(panel, 3, 'h-16');

        if (!id) {
            clear(panel);
            showEmptyState(panel, {
                title: 'No order specified',
                message: 'Open an order from your orders list to see its details.',
                icon: 'fa-receipt',
            });
            return;
        }

        try {
            const result = await api.get(`/orders/${id}`);
            const order = result?.data?.order || result?.data;

            if (!order) {
                clear(panel);
                showEmptyState(panel, {
                    title: 'Order not found',
                    message: 'This order does not exist, or it is not yours.',
                    icon: 'fa-receipt',
                });
                return;
            }

            render(order);
        } catch (error) {
            clear(panel);
            showEmptyState(panel, {
                title: 'Could not load this order',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function render(order) {
        document.title = `${order.orderReference} | Aurelia Grand Hotel`;
        clear(panel);

        // ---- Header ---------------------------------------------------------
        const header = createElement('div', {
            class: 'px-4 py-4 border-b border-stone-200 flex flex-wrap items-start justify-between gap-3',
        });

        const heading = createElement('div');
        heading.append(
            createElement('h2', { class: 'text-lg font-bold text-stone-900', text: order.orderReference }),
            createElement('p', {
                class: 'text-sm text-stone-500',
                text: `Placed ${formatDate(order.placedAt || order.createdAt)}`,
            }),
        );

        header.append(heading, statusBadge(order.status));
        panel.appendChild(header);

        // ---- Progress -------------------------------------------------------
        if (order.status !== 'cancelled') {
            panel.appendChild(progress(order.status));
        } else {
            panel.appendChild(
                createElement('div', { class: 'px-4 py-3 bg-red-50 text-sm text-red-700' }, [
                    createElement('i', { class: 'fa-solid fa-circle-xmark mr-2', 'aria-hidden': 'true' }),
                    createElement('span', {
                        text: `This order was cancelled${
                            order.cancellationReason ? `: ${order.cancellationReason}` : '.'
                        }`,
                    }),
                ]),
            );
        }

        // ---- Items ----------------------------------------------------------
        const body = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-0' });

        const itemsColumn = createElement('div', { class: 'lg:col-span-2 p-4' });
        const table = createElement('table', { class: 'w-full text-sm' });

        const head = createElement('thead');
        const headRow = createElement('tr', { class: 'border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500' });
        for (const [label, align] of [['Item', 'text-left'], ['Qty', 'text-center'], ['Total', 'text-right']]) {
            headRow.appendChild(createElement('th', { class: `${align} py-2`, text: label, scope: 'col' }));
        }
        head.appendChild(headRow);

        const tbody = createElement('tbody');
        for (const item of order.items || []) {
            const row = createElement('tr', { class: 'border-b border-stone-100' });
            const name = createElement('td', { class: 'py-2 pr-2' });
            name.appendChild(createElement('p', { class: 'text-stone-900', text: item.name }));
            if (item.specialInstructions) {
                name.appendChild(
                    createElement('p', { class: 'text-xs text-amber-700 italic', text: item.specialInstructions }),
                );
            }
            row.append(
                name,
                createElement('td', { class: 'py-2 text-center text-stone-600', text: String(item.quantity) }),
                createElement('td', { class: 'py-2 text-right text-stone-900', text: formatMoney(item.lineTotal) }),
            );
            tbody.appendChild(row);
        }

        table.append(head, tbody);
        itemsColumn.appendChild(table);

        // ---- Summary --------------------------------------------------------
        const summaryColumn = createElement('div', { class: 'p-4 bg-stone-50 border-t lg:border-t-0 lg:border-l border-stone-200' });
        summaryColumn.appendChild(createElement('h3', { class: 'font-semibold text-stone-900 mb-3', text: 'Summary' }));

        const totals = [
            ['Subtotal', order.subtotal],
            ['Tax', order.taxAmount],
            ['Service charge', order.serviceCharge],
        ];

        for (const [label, value] of totals) {
            const row = createElement('div', { class: 'flex justify-between text-sm py-1' });
            row.append(
                createElement('span', { class: 'text-stone-600', text: label }),
                createElement('span', { class: 'text-stone-900', text: formatMoney(value) }),
            );
            summaryColumn.appendChild(row);
        }

        const grand = createElement('div', { class: 'flex justify-between text-sm py-2 mt-1 border-t border-stone-300 font-semibold' });
        grand.append(
            createElement('span', { text: 'Total' }),
            createElement('span', { text: formatMoney(order.totalAmount) }),
        );
        summaryColumn.appendChild(grand);

        if (Number(order.balanceDue) > 0) {
            const due = createElement('div', { class: 'flex justify-between text-sm py-1 text-red-700' });
            due.append(
                createElement('span', { text: 'Balance due' }),
                createElement('span', { text: formatMoney(order.balanceDue) }),
            );
            summaryColumn.appendChild(due);

            summaryColumn.appendChild(
                createElement('a', {
                    href: `/pages/guest/payments.html?orderId=${order.id}`,
                    class: 'btn btn-primary btn-sm w-full mt-3',
                    text: 'Pay this order',
                }),
            );
        }

        body.append(itemsColumn, summaryColumn);
        panel.appendChild(body);

        // ---- Fulfilment -----------------------------------------------------
        const fulfilment = createElement('div', { class: 'px-4 py-3 border-t border-stone-200 text-sm text-stone-600' });
        fulfilment.textContent =
            order.fulfilmentType === 'room_delivery'
                ? `Being delivered to room ${order.roomNumber ?? '-'}.`
                : 'Collect from the restaurant.';
        panel.appendChild(fulfilment);
    }

    /** A horizontal stepper showing how far through the lifecycle this order is. */
    function progress(status) {
        const currentIndex = STEPS.findIndex((step) => step.key === status);
        const wrap = createElement('div', { class: 'px-4 py-4 border-b border-stone-200' });
        const list = createElement('ol', { class: 'flex flex-wrap items-center gap-x-2 gap-y-2' });

        STEPS.forEach((step, index) => {
            const reached = index <= currentIndex;
            const item = createElement('li', {
                class: `flex items-center gap-2 px-2 py-1 rounded-full text-xs ${
                    reached ? 'bg-amber-100 text-amber-900 font-medium' : 'bg-stone-100 text-stone-400'
                }`,
            });
            item.append(
                createElement('i', {
                    class: `fa-solid ${reached ? 'fa-check' : 'fa-circle'} text-[10px]`,
                    'aria-hidden': 'true',
                }),
                createElement('span', { text: step.label }),
            );

            if (index < STEPS.length - 1) {
                list.appendChild(item);
                if (index < currentIndex) {
                    list.appendChild(createElement('li', { class: 'text-stone-300 text-xs', 'aria-hidden': 'true', text: '›' }));
                }
            } else {
                list.appendChild(item);
            }
        });

        wrap.appendChild(list);
        return wrap;
    }

    await load();
}
