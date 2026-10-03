/**
 * public/js/pages/admin/invoices.js
 *
 * WHAT THIS MODULE DOES
 * The invoice ledger: every invoice issued across every guest, filterable by
 * status and date range.
 *
 * WHY IT EXISTS
 * Invoices are the hotel's paper trail. A manager reconciling a period needs
 * every one of them, which is a different question from "what are my
 * invoices", so this reads the staff-wide endpoint rather than the guest's own.
 *
 * WHY THE TOTALS ARE SHOWN PER ROW
 * An invoice that does not add up is the thing this screen exists to catch, so
 * subtotal, tax, service charge and total are all visible together rather than
 * behind a click.
 *
 * COMMUNICATION
 * Page -> GET /api/invoices/all   (the whole ledger, paginated)
 * Database tables used: invoices, bookings, orders, users
 */
import { buildShell } from '../../components/shell.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    personCell,
} from '../../components/admin-ui.js';
import { createElement, statusBadge, formatMoney, formatDate } from '../../lib/dom.js';

const ROLES = ['manager', 'admin', 'receptionist'];

const STATUSES = [
    { value: '', label: 'All statuses' },
    { value: 'unpaid', label: 'Unpaid' },
    { value: 'partially_paid', label: 'Part paid' },
    { value: 'paid', label: 'Paid' },
    { value: 'void', label: 'Void' },
];

const shell = await buildShell({
    title: 'Invoices',
    subtitle: 'Every invoice issued',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Invoice, booking or guest...' },
                { type: 'select', name: 'status', label: 'Status', options: STATUSES },
                { type: 'date', name: 'startDate', label: 'Issued from' },
                { type: 'date', name: 'endDate', label: 'Issued to' },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        {
            header: 'Invoice',
            render: (invoice) =>
                createElement('span', { class: 'font-mono text-xs text-stone-700', text: invoice.invoiceNumber }),
        },
        { header: 'Guest', render: (invoice) => personCell(invoice.guestName, invoice.guestEmail) },
        {
            header: 'For',
            render: (invoice) =>
                createElement('span', {
                    class: 'text-sm',
                    text: invoice.bookingReference
                        ? `Booking ${invoice.bookingReference}`
                        : invoice.orderReference
                          ? `Order ${invoice.orderReference}`
                          : '-',
                }),
        },
        {
            header: 'Subtotal',
            className: 'text-right',
            render: (invoice) => createElement('span', { class: 'text-sm', text: formatMoney(invoice.subtotal) }),
        },
        {
            header: 'Tax',
            className: 'text-right',
            render: (invoice) => createElement('span', { class: 'text-sm', text: formatMoney(invoice.taxAmount) }),
        },
        {
            header: 'Service',
            className: 'text-right',
            render: (invoice) =>
                createElement('span', { class: 'text-sm', text: formatMoney(invoice.serviceCharge) }),
        },
        {
            header: 'Total',
            className: 'text-right',
            render: (invoice) =>
                createElement('div', { class: 'text-sm text-right' }, [
                    createElement('p', { class: 'font-semibold', text: formatMoney(invoice.totalAmount) }),
                    Number(invoice.balanceDue) > 0
                        ? createElement('p', { class: 'text-xs text-red-600', text: `${formatMoney(invoice.balanceDue)} due` })
                        : null,
                ]),
        },
        { header: 'Status', render: (invoice) => statusBadge(invoice.status) },
        {
            header: 'Issued',
            render: (invoice) =>
                createElement('span', {
                    class: 'text-sm text-stone-600 whitespace-nowrap',
                    text: formatDate(invoice.issuedAt || invoice.createdAt),
                }),
        },
    ];

    const controller = createListController({
        endpoint: '/invoices/all',
        container: listHost,
        state: { status: '', search: '', startDate: '', endDate: '' },
        limit: 20,
        empty: {
            title: 'No invoices match',
            message: 'Invoices are created automatically when a booking or order is paid.',
            icon: 'fa-file-invoice',
        },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    await controller.load();
}
