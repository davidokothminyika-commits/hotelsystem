/**
 * public/js/pages/guest/invoices.js
 *
 * WHAT THIS MODULE DOES
 * The guest's own invoices, each expandable to show what it was for and what it
 * added up to.
 *
 * WHY THE BREAKDOWN IS SHOWN INLINE
 * An invoice is the document a guest checks when they think they have been
 * charged the wrong amount. Hiding the subtotal, tax and service charge behind a
 * download would answer the question later rather than now, so the arithmetic
 * is on the page where it can be checked.
 *
 * WHY ONLY THE CALLER'S INVOICES APPEAR
 * The endpoint returns the signed-in guest's invoices and nothing else; there is
 * no parameter to widen it.
 *
 * COMMUNICATION
 * Page -> GET /api/invoices   (this guest's invoices)
 *      -> GET /api/invoices/receipt?entity=&id=   (a receipt before one is issued)
 * Database tables used: invoices, bookings, orders
 */
import { buildShell } from '../../components/shell.js';
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

const shell = await buildShell({
    title: 'Invoices',
    subtitle: 'Every invoice raised for your account',
});

if (shell?.content) {
    const { content } = shell;

    const list = createElement('div', { class: 'space-y-3' });
    content.appendChild(list);

    async function load() {
        showSkeleton(list, 3, 'h-28');

        try {
            const result = await api.get('/invoices');
            const invoices = result?.data || [];

            clear(list);

            if (invoices.length === 0) {
                showEmptyState(list, {
                    title: 'No invoices yet',
                    message: 'An invoice is created automatically when you pay a booking or an order.',
                    icon: 'fa-file-invoice',
                });
                return;
            }

            for (const invoice of invoices) {
                list.appendChild(invoiceCard(invoice));
            }
        } catch (error) {
            clear(list);
            showEmptyState(list, {
                title: 'Could not load your invoices',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function invoiceCard(invoice) {
        const card = createElement('article', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
        });

        const header = createElement('button', {
            type: 'button',
            class: 'w-full px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-left',
            'aria-expanded': 'false',
        });

        const left = createElement('div', { class: 'min-w-0' });
        left.append(
            createElement('p', { class: 'font-semibold text-stone-900 font-mono text-sm', text: invoice.invoiceNumber }),
            createElement('p', {
                class: 'text-xs text-stone-500',
                text: `${invoice.bookingReference ? `Booking ${invoice.bookingReference}` : invoice.orderReference ? `Order ${invoice.orderReference}` : 'Hotel'} · Issued ${formatDate(invoice.issuedAt || invoice.createdAt)}`,
            }),
        );

        const right = createElement('div', { class: 'flex items-center gap-3' });
        right.append(
            createElement('span', { class: 'font-semibold text-stone-900', text: formatMoney(invoice.totalAmount) }),
            statusBadge(invoice.status),
            createElement('i', { class: 'fa-solid fa-chevron-down text-stone-400', 'aria-hidden': 'true' }),
        );

        header.append(left, right);

        // A native <details> would give this behaviour for free, but the rows
        // are styled as cards, so the toggle is driven here to keep the icon
        // and the aria state in step with the panel.
        const panel = createElement('div', { class: 'hidden px-4 pb-4' });
        panel.appendChild(breakdown(invoice));

        header.addEventListener('click', () => {
            const open = panel.classList.toggle('hidden') === false;
            header.setAttribute('aria-expanded', String(open));
            header.querySelector('i').className = open
                ? 'fa-solid fa-chevron-up text-stone-400'
                : 'fa-solid fa-chevron-down text-stone-400';
        });

        card.append(header, panel);
        return card;
    }

    function breakdown(invoice) {
        const wrap = createElement('div', { class: 'border-t border-stone-100 pt-3' });

        const table = createElement('table', { class: 'w-full text-sm' });
        const tbody = createElement('tbody');

        for (const [label, value] of [
            ['Subtotal', invoice.subtotal],
            ['Tax', invoice.taxAmount],
            ['Service charge', invoice.serviceCharge],
        ]) {
            const row = createElement('tr');
            row.append(
                createElement('td', { class: 'py-1 text-stone-600', text: label }),
                createElement('td', { class: 'py-1 text-right text-stone-900', text: formatMoney(value) }),
            );
            tbody.appendChild(row);
        }

        const totalRow = createElement('tr', { class: 'border-t border-stone-200 font-semibold' });
        totalRow.append(
            createElement('td', { class: 'py-2 text-stone-900', text: 'Total' }),
            createElement('td', { class: 'py-2 text-right text-stone-900', text: formatMoney(invoice.totalAmount) }),
        );
        tbody.appendChild(totalRow);

        if (Number(invoice.amountPaid) > 0) {
            const paidRow = createElement('tr');
            paidRow.append(
                createElement('td', { class: 'py-1 text-stone-600', text: 'Paid' }),
                createElement('td', { class: 'py-1 text-right text-emerald-700', text: `- ${formatMoney(invoice.amountPaid)}` }),
            );
            tbody.appendChild(paidRow);
        }

        table.appendChild(tbody);
        wrap.appendChild(table);

        if (Number(invoice.balanceDue) > 0) {
            wrap.appendChild(
                createElement('div', { class: 'mt-3 flex items-center justify-between gap-3' }, [
                    createElement('span', { class: 'text-sm text-red-700', text: `${formatMoney(invoice.balanceDue)} still due` }),
                    createElement('a', {
                        href: '/pages/guest/payments.html',
                        class: 'btn btn-primary btn-sm',
                        text: 'Pay now',
                    }),
                ]),
            );
        }

        if (invoice.paymentReference) {
            wrap.appendChild(
                createElement('p', {
                    class: 'text-xs text-stone-500 mt-3',
                    text: `Paid by ${invoice.paymentMethod === 'card' ? 'card' : invoice.paymentMethod === 'mobile_money' ? 'mobile money' : 'cash'} · reference ${invoice.paymentReference}`,
                }),
            );
        }

        return wrap;
    }

    await load();
}
