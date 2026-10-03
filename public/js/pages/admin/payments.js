/**
 * public/js/pages/admin/payments.js
 *
 * WHAT THIS MODULE DOES
 * Every payment attempt with its status, method and the masked card it came
 * from, plus the staff refund action.
 *
 * WHY IT EXISTS
 * Money in, money out. A manager reconciling takings needs to see completed
 * payments and, just as importantly, the failures: a run of declines usually
 * means a gateway problem rather than a run of careless guests.
 *
 * WHY ONLY THE LAST FOUR DIGHS ARE SHOWN
 * The API never returns a full card number, and this page renders whatever the
 * provider masked. That is not a display choice made here, it is a consequence
 * of nothing ever storing the full number.
 *
 * COMMUNICATION
 * Page -> GET  /api/payments        (filtered and paginated by the server)
 *      -> POST /api/payments/:id/refund
 * Database tables used: payments, invoices, bookings, orders, users
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
    formatMoney,
    formatDate,
} from '../../lib/dom.js';

const ROLES = ['manager', 'admin', 'receptionist'];

const STATUSES = [
    { value: '', label: 'All statuses' },
    { value: 'completed', label: 'Completed' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'failed', label: 'Failed' },
    { value: 'refunded', label: 'Refunded' },
];

const METHODS = [
    { value: '', label: 'All methods' },
    { value: 'card', label: 'Card' },
    { value: 'mobile_money', label: 'Mobile money' },
    { value: 'cash', label: 'Cash' },
];

const METHOD_LABEL = {
    card: 'Card',
    mobile_money: 'Mobile money',
    cash: 'Cash',
};

const shell = await buildShell({
    title: 'Payments',
    subtitle: 'Every payment attempt',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Reference or guest...' },
                { type: 'select', name: 'status', label: 'Status', options: STATUSES },
                { type: 'select', name: 'method', label: 'Method', options: METHODS },
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
            render: (payment) =>
                createElement('span', { class: 'font-mono text-xs text-stone-600', text: payment.paymentReference }),
        },
        { header: 'Guest', render: (payment) => personCell(payment.guestName, null) },
        {
            header: 'Paid for',
            render: (payment) =>
                createElement('span', {
                    class: 'text-sm',
                    text: payment.bookingReference
                        ? `Booking ${payment.bookingReference}`
                        : payment.orderReference
                          ? `Order ${payment.orderReference}`
                          : '-',
                }),
        },
        {
            header: 'Method',
            render: (payment) => {
                const label = METHOD_LABEL[payment.paymentMethod] || payment.paymentMethod;
                // Only the masked value the provider returned is ever shown.
                const lastFour = payment.providerResponse?.lastFour;
                const wrap = createElement('div', { class: 'text-sm' });
                wrap.appendChild(createElement('p', { text: label }));
                if (lastFour) {
                    wrap.appendChild(
                        createElement('p', {
                            class: 'text-xs text-stone-500 font-mono',
                            text: `•••• ${lastFour}${payment.providerResponse?.brand ? ` · ${payment.providerResponse.brand}` : ''}`,
                        }),
                    );
                }
                return wrap;
            },
        },
        { header: 'Status', render: (payment) => statusBadge(payment.status) },
        {
            header: 'Amount',
            className: 'text-right',
            render: (payment) =>
                createElement('div', { class: 'text-sm text-right' }, [
                    createElement('p', { class: 'font-medium', text: formatMoney(payment.amount, payment.currency) }),
                    payment.failureReason
                        ? createElement('p', {
                              class: 'text-xs text-red-600 truncate max-w-[180px]',
                              title: payment.failureReason,
                              text: payment.failureReason,
                          })
                        : null,
                ]),
        },
        {
            header: 'When',
            render: (payment) =>
                createElement('span', {
                    class: 'text-sm text-stone-600 whitespace-nowrap',
                    text: formatDate(payment.paidAt || payment.createdAt),
                }),
        },
        { header: 'Actions', className: 'text-right', render: (payment) => actionsFor(payment) },
    ];

    const controller = createListController({
        endpoint: '/payments',
        container: listHost,
        state: { status: '', method: '', search: '', startDate: '', endDate: '' },
        limit: 20,
        empty: { title: 'No payments match', message: 'Try a different filter.', icon: 'fa-credit-card' },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    /**
     * Only a completed payment can be refunded. Offering the action on a failed
     * attempt would produce a rejection the user cannot act on, because there
     * is nothing to give back.
     */
    function actionsFor(payment) {
        if (payment.status !== 'completed') return createElement('span', { class: 'text-xs text-stone-400', text: '—' });

        return actionButtons([
            {
                icon: 'fa-rotate-left',
                label: 'Refund this payment',
                className: 'btn btn-ghost btn-sm',
                onClick: () => refund(payment),
            },
        ]);
    }

    async function refund(payment) {
        const done = await confirmAndRun({
            title: 'Refund this payment?',
            message: `${formatMoney(payment.amount, payment.currency)} taken by ${payment.paymentReference} will be returned to ${payment.guestName || 'the guest'}.`,
            confirmLabel: 'Refund it',
            variant: 'danger',
            run: () => api.post(`/payments/${payment.id}/refund`, { reason: 'Refunded from the admin console' }),
        });

        if (done) {
            notify.success('Refund submitted.');
            controller.load();
        }
    }

    await controller.load();
}
