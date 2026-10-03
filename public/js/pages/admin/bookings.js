/**
 * public/js/pages/admin/bookings.js
 *
 * WHAT THIS MODULE DOES
 * Every booking in the system, filterable by status, with the lifecycle actions
 * available to staff.
 *
 * WHY IT EXISTS
 * The front desk page answers "who is arriving today". This one answers "what
 * happened to any booking", including cancelled and completed stays, which is
 * what a manager needs when a guest queries an old reservation.
 *
 * WHY THE STATUS COMES FROM THE URL
 * The dashboard links here with ?status=pending, and the attention panel links
 * to the queues it names. Honouring the query parameter means those links land
 * on the filtered list they promised rather than on the unfiltered default.
 *
 * COMMUNICATION
 * Page -> GET  /api/bookings        (filtered and paginated by the server)
 *      -> POST /api/bookings/:id/confirm | check-in | check-out | cancel
 * Database tables used: bookings, rooms, users
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
    dateCell,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    statusBadge,
    statusLabel,
    formatMoney,
    getQueryParam,
} from '../../lib/dom.js';

const ROLES = ['receptionist', 'manager', 'admin'];

const STATUSES = [
    { value: '', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'checked_in', label: 'Checked in' },
    { value: 'checked_out', label: 'Checked out' },
    { value: 'cancelled', label: 'Cancelled' },
];

const shell = await buildShell({
    title: 'Bookings',
    subtitle: 'Every reservation',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    const state = {
        status: getQueryParam('status') || '',
        search: '',
        checkInFrom: '',
        checkInTo: '',
    };

    const toolbar = createToolbar(
        [
            { type: 'search', name: 'search', label: 'Search', placeholder: 'Reference, guest or room...' },
            { type: 'select', name: 'status', label: 'Status', options: STATUSES },
            { type: 'date', name: 'checkInFrom', label: 'Arriving from' },
            { type: 'date', name: 'checkInTo', label: 'Arriving to' },
            {
                type: 'button',
                label: 'Clear',
                icon: 'fa-xmark',
                className: 'btn btn-ghost',
                onClick: () => {
                    state.status = '';
                    state.search = '';
                    state.checkInFrom = '';
                    state.checkInTo = '';
                    // Reset the visible controls too, otherwise the chips and
                    // the query state disagree until the page is reloaded.
                    toolbar.querySelectorAll('input, select').forEach((input) => {
                        input.value = '';
                    });
                    controller.setFilter('status', '');
                    controller.state.search = '';
                    controller.state.checkInFrom = '';
                    controller.state.checkInTo = '';
                    controller.state.page = 1;
                    controller.load();
                },
            },
        ],
        (name, value) => {
            if (name === 'search') {
                // Debounced so typing does not fire a request per keystroke.
                controller.setFilter('search', value);
                return;
            }
            controller.setFilter(name, value);
        },
    );

    content.appendChild(toolbar);

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        {
            header: 'Reference',
            render: (booking) =>
                createElement('span', { class: 'font-mono text-xs text-stone-600', text: booking.bookingReference }),
        },
        { header: 'Guest', render: (booking) => personCell(booking.guestName, booking.guestEmail) },
        { header: 'Room', render: (booking) => createElement('span', { text: booking.roomNumber ?? '-' }) },
        {
            header: 'Stay',
            render: (booking) => {
                const wrap = createElement('div', { class: 'text-sm whitespace-nowrap' });
                wrap.append(
                    createElement('p', { text: `${dateCellText(booking.checkIn)} to ${dateCellText(booking.checkOut)}` }),
                    createElement('p', { class: 'text-xs text-stone-500', text: `${booking.nights || 0} night(s)` }),
                );
                return wrap;
            },
        },
        { header: 'Status', render: (booking) => statusBadge(booking.status) },
        {
            header: 'Total',
            className: 'text-right',
            render: (booking) =>
                createElement('div', { class: 'text-sm text-right' }, [
                    createElement('p', { class: 'font-medium', text: formatMoney(booking.totalAmount) }),
                    Number(booking.balanceDue) > 0
                        ? createElement('p', {
                              class: 'text-xs text-red-600',
                              text: `${formatMoney(booking.balanceDue)} due`,
                          })
                        : null,
                ]),
        },
        { header: 'Actions', className: 'text-right', render: (booking) => actionsFor(booking) },
    ];

    const controller = createListController({
        endpoint: '/bookings',
        container: listHost,
        state,
        limit: 15,
        empty: {
            title: 'No bookings match',
            message: 'Adjust the filters, or clear them to see every booking.',
            icon: 'fa-calendar',
        },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            // Appended to the controller's slot, not to the host: the host also
            // holds the pager, which clearing would remove.
            slot.appendChild(table.wrapper);
        },
    });

    function dateCellText(value) {
        return dateCell(value).textContent;
    }

    /** Actions valid for this booking's status. */
    function actionsFor(booking) {
        const acts = [];

        if (booking.status === 'pending') {
            acts.push({
                icon: 'fa-check',
                label: 'Confirm',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'confirm'),
            });
        }
        if (booking.status === 'confirmed') {
            acts.push({
                icon: 'fa-door-open',
                label: 'Check in',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'check-in'),
            });
        }
        if (booking.status === 'checked_in') {
            acts.push({
                icon: 'fa-door-closed',
                label: 'Check out',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'check-out'),
            });
        }
        if (['pending', 'confirmed'].includes(booking.status)) {
            acts.push({
                icon: 'fa-xmark',
                label: 'Cancel',
                className: 'btn btn-ghost btn-sm',
                onClick: () => cancel(booking),
            });
        }

        return acts.length ? actionButtons(acts) : statusLabel(booking.status);
    }

    async function transition(booking, action) {
        const done = await confirmAndRun({
            title: `Confirm this ${action.replace('-', ' ')}?`,
            message: `${booking.guestName} · ${booking.bookingReference}`,
            confirmLabel: 'Yes',
            variant: 'primary',
            run: () => api.post(`/bookings/${booking.id}/${action}`, {}),
        });

        if (done) {
            notify.success(`Booking ${booking.bookingReference} updated.`);
            controller.load();
        }
    }

    async function cancel(booking) {
        const done = await confirmAndRun({
            title: 'Cancel this booking?',
            message: `${booking.guestName} · ${booking.bookingReference}. The room is released and this cannot be undone.`,
            confirmLabel: 'Yes, cancel it',
            variant: 'danger',
            run: () => api.post(`/bookings/${booking.id}/cancel`, { reason: 'Cancelled by staff' }),
        });

        if (done) {
            notify.success('Booking cancelled.');
            controller.load();
        }
    }

    await controller.load();
}
