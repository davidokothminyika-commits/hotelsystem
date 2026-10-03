/**
 * public/js/pages/admin/orders.js
 *
 * WHAT THIS MODULE DOES
 * Every order in the system with its status, fulfilment type and balance, plus
 * the status transitions staff may apply.
 *
 * WHY IT EXISTS
 * The kitchen board shows what is happening right now. This shows everything,
 * including delivered and cancelled orders, which is what a manager needs when
 * reconciling revenue or answering a guest who says an order never arrived.
 *
 * COMMUNICATION
 * Page -> GET  /api/orders        (filtered and paginated by the server)
 *      -> PATCH /api/orders/:id/status
 *      -> POST  /api/orders/:id/cancel
 * Database tables used: orders, order_items, menu_items, users, rooms
 */
import { buildShell } from '../../components/shell.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    actionButtons,
    confirmAndRun,
    personCell,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    statusBadge,
    statusLabel,
    formatMoney,
    formatDate,
} from '../../lib/dom.js';

const ROLES = ['restaurant_staff', 'manager', 'admin'];

const STATUSES = [
    { value: '', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'preparing', label: 'Preparing' },
    { value: 'ready', label: 'Ready' },
    { value: 'out_for_delivery', label: 'Out for delivery' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'cancelled', label: 'Cancelled' },
];

const FULFILMENT = [
    { value: '', label: 'All types' },
    { value: 'restaurant_pickup', label: 'Restaurant pickup' },
    { value: 'room_delivery', label: 'Room delivery' },
];

/** The status each current status may move to. */
const NEXT = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['ready'],
    ready: ['out_for_delivery', 'delivered'],
    out_for_delivery: ['delivered'],
};

const shell = await buildShell({
    title: 'Orders',
    subtitle: 'Every order and its status',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Reference or guest...' },
                { type: 'select', name: 'status', label: 'Status', options: STATUSES },
                { type: 'select', name: 'fulfilmentType', label: 'Fulfilment', options: FULFILMENT },
                { type: 'date', name: 'startDate', label: 'From' },
                { type: 'date', name: 'endDate', label: 'To' },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        {
            header: 'Reference',
            render: (order) =>
                createElement('span', { class: 'font-mono text-xs text-stone-600', text: order.orderReference }),
        },
        { header: 'Guest', render: (order) => personCell(order.guestName, null) },
        {
            header: 'Fulfilment',
            render: (order) =>
                createElement('span', {
                    class: 'text-sm',
                    text:
                        order.fulfilmentType === 'room_delivery'
                            ? `Room ${order.roomNumber ?? '-'}`
                            : 'Pickup',
                }),
        },
        { header: 'Status', render: (order) => statusBadge(order.status) },
        {
            header: 'Placed',
            render: (order) =>
                createElement('span', {
                    class: 'text-sm text-stone-600 whitespace-nowrap',
                    text: formatDate(order.placedAt || order.createdAt),
                }),
        },
        {
            header: 'Total',
            className: 'text-right',
            render: (order) =>
                createElement('div', { class: 'text-sm text-right' }, [
                    createElement('p', { class: 'font-medium', text: formatMoney(order.totalAmount) }),
                    Number(order.balanceDue) > 0
                        ? createElement('p', { class: 'text-xs text-red-600', text: `${formatMoney(order.balanceDue)} due` })
                        : null,
                ]),
        },
        { header: 'Actions', className: 'text-right', render: (order) => actionsFor(order) },
    ];

    const controller = createListController({
        endpoint: '/orders',
        container: listHost,
        state: { status: '', search: '', fulfilmentType: '', startDate: '', endDate: '' },
        limit: 15,
        empty: { title: 'No orders match', message: 'Try a different filter.', icon: 'fa-receipt' },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    function actionsFor(order) {
        const acts = [];

        for (const target of NEXT[order.status] || []) {
            const isCancel = target === 'cancelled';
            acts.push({
                icon: isCancel ? 'fa-xmark' : 'fa-arrow-right',
                label: isCancel ? 'Cancel order' : `Mark ${statusLabel(target).toLowerCase()}`,
                className: isCancel ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm',
                onClick: () => (isCancel ? cancel(order) : advance(order, target)),
            });
        }

        return acts.length ? actionButtons(acts) : statusLabel(order.status);
    }

    async function advance(order, target) {
        const done = await confirmAndRun({
            title: `Mark this order ${statusLabel(target).toLowerCase()}?`,
            message: `${order.orderReference} · ${order.guestName || 'Guest'}`,
            confirmLabel: 'Yes',
            run: () => api.patch(`/orders/${order.id}/status`, { status: target }),
        });

        if (done) {
            notify.success(`Order ${order.orderReference} updated.`);
            controller.load();
        }
    }

    async function cancel(order) {
        const done = await confirmAndRun({
            title: 'Cancel this order?',
            message: `${order.orderReference} will be cancelled. This cannot be undone.`,
            confirmLabel: 'Yes, cancel it',
            run: () => api.post(`/orders/${order.id}/cancel`, { reason: 'Cancelled by staff' }),
        });

        if (done) {
            notify.success('Order cancelled.');
            controller.load();
        }
    }

    await controller.load();
}
