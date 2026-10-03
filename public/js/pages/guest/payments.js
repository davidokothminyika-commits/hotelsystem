/**
 * public/js/pages/guest/payments.js
 *
 * WHAT THIS MODULE DOES
 * Pay a balance on a booking or an order, and see the payment history.
 *
 * WHY THE FORM IS A PAGE RATHER THAN A MODAL
 * Paying is the single most failure-prone action a guest takes, and it may be
 * the second of three attempts after a decline. A modal that discards its
 * contents on close would make a retry mean retyping everything, so the form
 * lives in the page and keeps its values when the gateway declines.
 *
 * WHY A DECLINE IS NOT TREATED AS AN ERROR
 * A declined card is a normal outcome, not a malfunction. The service answers
 * with 402 and the recorded attempt, so this page shows the gateway's own
 * message and keeps the form filled in, rather than clearing it and reporting a
 * generic failure.
 *
 * WHY THE AMOUNT IS NEVER SENT
 * The form has no amount field. The server recomputes the outstanding balance and
 * charges that, so a guest cannot be talked into paying a different number and a
 * tampered request cannot change what is charged.
 *
 * COMMUNICATION
 * Page -> GET  /api/payments/config   (methods and, in simulation, test cards)
 *      -> GET  /api/bookings          (what can be paid)
 *      -> GET  /api/orders            (what can be paid)
 *      -> POST /api/payments          (the charge)
 *      -> GET  /api/payments          (history)
 * Database tables used: payments, invoices, bookings, orders
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
    setButtonLoading,
} from '../../lib/dom.js';

const METHOD_LABEL = { card: 'Card', mobile_money: 'Mobile money', cash: 'Cash' };

const shell = await buildShell({
    title: 'Payments',
    subtitle: 'Settle a balance and review your payments',
});

if (shell?.content) {
    const { content } = shell;

    let config = null;
    let targets = [];

    const grid = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' });
    content.appendChild(grid);

    const payColumn = createElement('div');
    const historyColumn = createElement('div');
    grid.append(payColumn, historyColumn);

    // =====================================================================
    // Pay panel
    // =====================================================================
    function payPanel() {
        const section = createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' });
        section.appendChild(
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
                createElement('h2', { class: 'font-semibold text-stone-900', text: 'Make a payment' }),
            ]),
        );

        const body = createElement('div', { class: 'p-4 space-y-4' });
        section.appendChild(body);
        return { section, body };
    }

    const { section: paySection, body: payBody } = payPanel();
    payColumn.appendChild(paySection);

    // =====================================================================
    // History
    // =====================================================================
    const historySection = createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' });
    historySection.appendChild(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Payment history' }),
        ]),
    );
    const historyBody = createElement('div', { class: 'p-3 space-y-2' });
    historySection.appendChild(historyBody);
    historyColumn.appendChild(historySection);

    // =====================================================================
    // Targets: what the guest owes
    // =====================================================================
    async function loadTargets() {
        clear(payBody);
        showSkeleton(payBody, 2, 'h-20');

        try {
            // Both lists are scoped to the signed-in guest by the service, so
            // these two calls are the complete set of things they can pay.
            const [bookings, orders] = await Promise.all([
                api.get('/bookings?limit=50').catch(() => null),
                api.get('/orders?limit=50').catch(() => null),
            ]);

            targets = [
                ...(bookings?.data || [])
                    .filter((booking) => Number(booking.balanceDue) > 0)
                    .map((booking) => ({
                        entity: 'booking',
                        id: booking.id,
                        label: `Booking ${booking.bookingReference}`,
                        detail: `Room ${booking.roomNumber ?? '-'} · ${booking.checkIn} to ${booking.checkOut}`,
                        amount: Number(booking.balanceDue),
                    })),
                ...(orders?.data || [])
                    .filter((order) => Number(order.balanceDue) > 0)
                    .map((order) => ({
                        entity: 'order',
                        id: order.id,
                        label: `Order ${order.orderReference}`,
                        detail:
                            order.fulfilmentType === 'room_delivery'
                                ? `Room ${order.roomNumber ?? '-'} delivery`
                                : 'Restaurant pickup',
                        amount: Number(order.balanceDue),
                    })),
            ].sort((a, b) => b.amount - a.amount);

            renderTargets();
        } catch (error) {
            clear(payBody);
            showEmptyState(payBody, {
                title: 'Could not load your balances',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    let selected = null;

    function renderTargets() {
        clear(payBody);

        if (targets.length === 0) {
            showEmptyState(payBody, {
                title: 'Nothing to pay',
                message: 'You have no outstanding balance on any booking or order.',
                icon: 'fa-circle-check',
            });
            return;
        }

        // A deep link from the booking or order page selects the target for
        // the guest, so they arrive on the form rather than having to find it.
        const bookingId = getQueryParam('bookingId');
        const orderId = getQueryParam('orderId');
        if (bookingId) selected = targets.find((t) => t.entity === 'booking' && String(t.id) === bookingId);
        if (orderId) selected = targets.find((t) => t.entity === 'order' && String(t.id) === orderId);

        const picker = createElement('div');
        picker.appendChild(createElement('label', { class: 'form-label', text: 'What are you paying?' }));

        const select = createElement('select', { class: 'form-select' });
        for (const target of targets) {
            select.appendChild(
                createElement('option', {
                    value: `${target.entity}:${target.id}`,
                    text: `${target.label} — ${formatMoney(target.amount)}`,
                }),
            );
        }
        if (selected) {
            select.value = `${selected.entity}:${selected.id}`;
        }

        picker.appendChild(select);
        payBody.appendChild(picker);

        const amountRow = createElement('div', { class: 'flex items-center justify-between p-3 rounded-lg bg-amber-50' });
        const formSlot = createElement('div');

        payBody.append(amountRow, formSlot);

        function paintSelection() {
            const [entity, id] = select.value.split(':');
            selected = targets.find((t) => t.entity === entity && String(t.id) === id);

            clear(amountRow);
            amountRow.append(
                createElement('span', { class: 'text-sm text-stone-700', text: 'Amount to pay' }),
                createElement('span', { class: 'text-lg font-bold text-stone-900', text: formatMoney(selected?.amount ?? 0) }),
            );

            clear(formSlot);
            formSlot.appendChild(buildForm());
        }

        select.addEventListener('change', paintSelection);
        paintSelection();
    }

    /** The card / mobile money / cash form for the chosen target. */
    function buildForm() {
        const form = createElement('form', { class: 'space-y-4' });

        const methods = config?.methods || ['card', 'mobile_money', 'cash'];

        // Method selector.
        const methodField = createElement('div');
        methodField.appendChild(createElement('label', { class: 'form-label', text: 'Payment method' }));
        const methodSelect = createElement('select', { class: 'form-select', name: 'method' });
        for (const method of methods) {
            methodSelect.appendChild(createElement('option', { value: method, text: METHOD_LABEL[method] || method }));
        }
        methodField.appendChild(methodSelect);

        // Card fields, shown only for a card payment.
        const cardFields = createElement('div', { class: 'space-y-3 hidden' });
        const expiryRow = createElement('div', { class: 'grid grid-cols-2 gap-3' });

        for (const [name, label, type, placeholder, attrs] of [
            ['cardNumber', 'Card number', 'text', '4242 4242 4242 4242', { inputmode: 'numeric', autocomplete: 'cc-number' }],
            ['cardHolder', 'Name on card', 'text', 'As printed on the card', { autocomplete: 'cc-name' }],
        ]) {
            const group = createElement('div');
            group.appendChild(createElement('label', { class: 'form-label', for: `pay-${name}`, text: label }));
            group.appendChild(
                createElement('input', { class: 'form-input', id: `pay-${name}`, name, type, placeholder, ...attrs }),
            );
            cardFields.appendChild(group);
        }

        for (const [name, label, type, placeholder, attrs] of [
            ['expiryMonth', 'Expiry month', 'number', 'MM', { min: 1, max: 12 }],
            ['expiryYear', 'Expiry year', 'number', 'YYYY', { min: new Date().getFullYear(), max: 2099 }],
            ['cvv', 'Security code', 'password', '123', { autocomplete: 'cc-csc' }],
        ]) {
            const group = createElement('div');
            group.appendChild(createElement('label', { class: 'form-label', for: `pay-${name}`, text: label }));
            group.appendChild(
                createElement('input', { class: 'form-input', id: `pay-${name}`, name, type, placeholder, ...attrs }),
            );
            expiryRow.appendChild(group);
        }
        cardFields.appendChild(expiryRow);

        // Mobile money fields.
        const mobileFields = createElement('div', { class: 'hidden' });
        mobileFields.appendChild(createElement('label', { class: 'form-label', for: 'pay-mobile', text: 'Mobile money number' }));
        mobileFields.appendChild(
            createElement('input', {
                class: 'form-input',
                id: 'pay-mobile',
                name: 'mobileNumber',
                type: 'tel',
                placeholder: '0712345678',
                autocomplete: 'tel',
            }),
        );

        const notice = createElement('div', {
            id: 'payment-notice',
            class: 'hidden p-3 rounded-lg text-sm',
        });

        const submit = createElement('button', {
            type: 'submit',
            class: 'btn btn-primary w-full',
            text: `Pay ${formatMoney(selected?.amount ?? 0)}`,
        });

        form.append(methodField, cardFields, mobileFields, notice, submit);

        // Cash needs no card details at all, so the fields are hidden rather
        // than disabled, which would still submit empty values.
        function syncMethodFields() {
            const method = methodSelect.value;
            cardFields.classList.toggle('hidden', method !== 'card');
            mobileFields.classList.toggle('hidden', method !== 'mobile_money');
        }

        methodSelect.addEventListener('change', syncMethodFields);
        syncMethodFields();

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!selected) return;

            notice.className = 'hidden';
            notice.removeAttribute('role');

            const data = new FormData(form);
            const payload = {
                entity: selected.entity,
                id: selected.id,
                method: methodSelect.value,
                cardNumber: data.get('cardNumber') || undefined,
                cardHolder: data.get('cardHolder') || undefined,
                expiryMonth: data.get('expiryMonth') ? Number(data.get('expiryMonth')) : undefined,
                expiryYear: data.get('expiryYear') ? Number(data.get('expiryYear')) : undefined,
                cvv: data.get('cvv') || undefined,
                mobileNumber: data.get('mobileNumber') || undefined,
            };

            setButtonLoading(submit, true, 'Processing...');

            try {
                const result = await api.post('/payments', payload);
                notify.success(result?.message || 'Payment complete.');
                loadTargets();
                loadHistory();
            } catch (error) {
                // The form is deliberately not cleared: the guest will usually
                // correct one field and try again, and losing the card number
                // makes a retry needlessly painful.
                if (error.status === 402 || error.isValidationError) {
                    notice.textContent = error.message;
                    notice.className = 'p-3 rounded-lg text-sm bg-red-50 text-red-700';
                    notice.setAttribute('role', 'alert');
                } else {
                    notify.error(error.message);
                }
            } finally {
                setButtonLoading(submit, false);
            }
        });

        return form;
    }

    // =====================================================================
    // History
    // =====================================================================
    async function loadHistory() {
        showSkeleton(historyBody, 4, 'h-16');

        try {
            const result = await api.get('/payments', { query: { limit: 20 } });
            const payments = result?.data || [];

            clear(historyBody);

            if (payments.length === 0) {
                showEmptyState(historyBody, {
                    title: 'No payments yet',
                    message: 'Your payments will appear here.',
                    icon: 'fa-credit-card',
                });
                return;
            }

            for (const payment of payments) {
                historyBody.appendChild(paymentRow(payment));
            }
        } catch (error) {
            clear(historyBody);
            showEmptyState(historyBody, {
                title: 'Could not load your payments',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function paymentRow(payment) {
        const row = createElement('div', { class: 'border border-stone-200 rounded-lg p-3' });

        const top = createElement('div', { class: 'flex items-start justify-between gap-2' });
        const left = createElement('div', { class: 'min-w-0' });
        left.append(
            createElement('p', { class: 'text-sm font-medium text-stone-900', text: formatMoney(payment.amount, payment.currency) }),
            createElement('p', {
                class: 'text-xs text-stone-500',
                text: `${METHOD_LABEL[payment.paymentMethod] || payment.paymentMethod} · ${formatDate(payment.paidAt || payment.createdAt)}`,
            }),
        );
        top.append(left, statusBadge(payment.status));
        row.appendChild(top);

        // The failure reason is the most useful thing on a declined row, and
        // the gateway's wording is more specific than anything we could invent.
        if (payment.failureReason) {
            row.appendChild(
                createElement('p', { class: 'text-xs text-red-600 mt-1', text: payment.failureReason }),
            );
        }

        if (payment.invoiceNumber) {
            row.appendChild(
                createElement('a', {
                    href: '/pages/guest/invoices.html',
                    class: 'text-xs text-amber-700 hover:underline mt-1 inline-block',
                    text: `Invoice ${payment.invoiceNumber}`,
                }),
            );
        }

        return row;
    }

    // =====================================================================
    // Boot
    // =====================================================================
    config = (await api.get('/payments/config').catch(() => null))?.data;

    // In simulation the documented test cards are shown, so the decline paths
    // can be demonstrated deliberately rather than by accident.
    if (config?.simulated && (config.testCards || []).length) {
        const hint = createElement('div', {
            class: 'mb-6 p-3 rounded-lg bg-stone-100 text-xs text-stone-600',
        });
        hint.appendChild(
            createElement('p', {
                class: 'font-medium text-stone-700 mb-1',
                text: 'Simulated gateway: test cards',
            }),
        );
        for (const card of config.testCards) {
            const line = createElement('p', { class: 'font-mono' });
            line.textContent = `${card.number} — ${card.label}`;
            hint.appendChild(line);
        }
        content.insertBefore(hint, grid);
    }

    await Promise.all([loadTargets(), loadHistory()]);
}
