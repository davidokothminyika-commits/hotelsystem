/**
 * public/js/pages/booking-details.js
 *
 * WHAT THIS MODULE DOES
 * A single booking in full: dates, room, guest, price breakdown, payment
 * status, and a print action that produces a clean confirmation document.
 *
 * WHY IT EXISTS
 * Guests need something they can show at reception or keep for their records.
 * The page doubles as the printable confirmation, so there is no separate
 * template to keep in sync.
 *
 * COMMUNICATION
 * Page -> /api/bookings/:id (the booking, ownership checked server side)
 *      -> POST /api/bookings/:id/cancel (cancellation)
 */
import { buildShell } from '../components/shell.js';
import { confirmDialog } from '../components/modal.js';
import notify from '../components/notification.js';
import api from '../api/api.js';
import {
    createElement,
    formatMoney,
    formatDate,
    statusBadge,
    showSkeleton,
    getQueryParam,
    setButtonLoading,
} from '../lib/dom.js';

const bookingId = getQueryParam('id');

const shell = await buildShell({
    title: 'Booking details',
    subtitle: '',
});

if (shell?.content) {
    const { content } = shell;

    if (!bookingId) {
        content.appendChild(
            createElement('div', {
                class: 'card p-8 text-center',
                text: 'No booking was specified. Go to My bookings to choose one.',
            }),
        );
    } else {
        const body = createElement('div', { class: 'max-w-3xl mx-auto', id: 'booking-detail' });
        content.appendChild(body);
        showSkeleton(body, 1, 'h-96');

        async function load() {
            try {
                const result = await api.get(`/bookings/${bookingId}`);
                const booking = result.data.booking;

                // Just created, or the guest arrived from a specific list.
                if (getQueryParam('created')) {
                    notify.success(`Booking ${booking.bookingReference} created.`);
                }

                render(booking);
            } catch (error) {
                body.textContent = '';
                body.appendChild(
                    createElement('div', {
                        class: 'card p-8 text-center',
                    }, [
                        createElement('i', { class: 'fa-solid fa-triangle-exclamation text-3xl text-amber-500 mb-3', 'aria-hidden': 'true' }),
                        createElement('p', { class: 'font-semibold text-stone-900 mb-1', text: 'Booking not found' }),
                        createElement('p', { class: 'text-sm text-stone-500 mb-4', text: error.message }),
                        createElement('a', { href: '/pages/guest/bookings.html', class: 'btn btn-primary', text: 'Back to my bookings' }),
                    ]),
                );
            }
        }

        function render(booking) {
            body.textContent = '';

            // ---- Confirmation banner, only right after booking ----
            if (getQueryParam('created')) {
                const banner = createElement('div', {
                    class: 'rounded-lg bg-green-50 border border-green-200 px-5 py-4 mb-6',
                });
                banner.appendChild(
                    createElement('p', { class: 'font-semibold text-green-900 mb-1', text: 'Your booking is confirmed' }),
                );
                banner.appendChild(
                    createElement('p', {
                        class: 'text-sm text-green-800',
                        text: `Keep reference ${booking.bookingReference}. Our team will have it on file.`,
                    }),
                );
                body.appendChild(banner);
            }

            // ---- Main card ----
            const card = createElement('article', { class: 'card' });

            // ---- Header ----
            const header = createElement('div', { class: 'card-header flex flex-wrap items-start justify-between gap-3' });

            const titleWrap = document.createElement('div');
            titleWrap.appendChild(
                createElement('h2', { class: 'text-lg font-semibold text-stone-900', text: `${booking.roomType || 'Room'} ${booking.roomNumber}` }),
            );

            const refRow = document.createElement('div');
            refRow.className = 'flex items-center gap-2 mt-1.5';
            refRow.appendChild(createElement('span', { class: 'font-mono text-sm text-stone-600', text: booking.bookingReference }));
            refRow.appendChild(statusBadge(booking.status));
            titleWrap.appendChild(refRow);
            header.appendChild(titleWrap);

            const amount = document.createElement('div');
            amount.className = 'text-right';
            amount.appendChild(createElement('p', { class: 'text-2xl font-bold text-stone-900', text: formatMoney(booking.totalAmount) }));

            if (Number(booking.balanceDue) > 0) {
                amount.appendChild(
                    createElement('p', {
                        class: 'text-sm text-amber-700 font-medium mt-0.5',
                        text: `${formatMoney(booking.balanceDue)} outstanding`,
                    }),
                );
            }
            header.appendChild(amount);
            card.appendChild(header);

            // ---- Body ----
            const cardBody = createElement('div', { class: 'card-body' });

            // Stay dates
            cardBody.appendChild(
                detailRow('Stay', [
                    { label: 'Check in', value: formatDate(booking.checkIn) },
                    { label: 'Check out', value: formatDate(booking.checkOut) },
                    { label: 'Nights', value: String(booking.nights) },
                    { label: 'Guests', value: String(booking.guests) },
                ]),
            );

            // Guest details
            if (booking.guestName) {
                cardBody.appendChild(
                    detailRow('Guest', [
                        { label: 'Name', value: booking.guestName },
                        { label: 'Email', value: booking.guestEmail || '-' },
                    ]),
                );
            }

            // Special requests, only shown when there are any
            if (booking.specialRequests) {
                const requests = createElement('div', { class: 'py-4 border-b border-stone-100' });
                requests.appendChild(createElement('p', { class: 'text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2', text: 'Special requests' }));
                requests.appendChild(createElement('p', { class: 'text-sm text-stone-700', text: booking.specialRequests }));
                cardBody.appendChild(requests);
            }

            // Price breakdown
            const totals = createElement('div', { class: 'py-4' });
            totals.appendChild(createElement('p', { class: 'text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2', text: 'Charges' }));

            const lines = [
                { label: `${formatMoney(booking.pricePerNight)} x ${booking.nights} night${booking.nights === 1 ? '' : 's'}`, value: booking.subtotal },
                { label: 'Tax (16%)', value: booking.taxAmount },
                { label: 'Service charge (10%)', value: booking.serviceCharge },
            ];

            for (const line of lines) {
                const row = createElement('div', { class: 'flex justify-between text-sm text-stone-600 py-1' });
                row.append(createElement('span', { text: line.label }), createElement('span', { text: formatMoney(line.value) }));
                totals.appendChild(row);
            }

            const totalRow = createElement('div', { class: 'flex justify-between font-bold text-stone-900 pt-2 mt-2 border-t border-stone-200' });
            totalRow.append(createElement('span', { text: 'Total' }), createElement('span', { text: formatMoney(booking.totalAmount) }));
            totals.appendChild(totalRow);

            if (Number(booking.amountPaid) > 0) {
                const paidRow = createElement('div', { class: 'flex justify-between text-sm text-green-700 pt-1' });
                paidRow.append(createElement('span', { text: 'Paid' }), createElement('span', { text: `-${formatMoney(booking.amountPaid)}` }));
                totals.appendChild(paidRow);
            }

            cardBody.appendChild(totals);
            card.appendChild(cardBody);

            // ---- Footer with actions ----
            const footer = createElement('div', { class: 'card-footer no-print flex flex-wrap items-center gap-2' });

            const printButton = createElement('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Print confirmation' });
            printButton.prepend(createElement('i', { class: 'fa-solid fa-print mr-2', 'aria-hidden': 'true' }));
            printButton.addEventListener('click', () => window.print());

            footer.appendChild(printButton);

            if (Number(booking.balanceDue) > 0) {
                const payButton = createElement('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Pay balance' });
                payButton.prepend(createElement('i', { class: 'fa-solid fa-credit-card mr-2', 'aria-hidden': 'true' }));
                payButton.addEventListener('click', () => {
                    window.location.href = `/pages/guest/payments.html?bookingId=${booking.id}`;
                });
                footer.appendChild(payButton);
            }

            if (['pending', 'confirmed'].includes(booking.status)) {
                const cancelButton = createElement('button', { type: 'button', class: 'btn btn-ghost btn-sm text-red-700', text: 'Cancel booking' });
                cancelButton.addEventListener('click', () => cancelBooking(booking));
                footer.appendChild(cancelButton);
            }

            card.appendChild(footer);
            body.appendChild(card);

            // ---- Footer note, hidden when printing ----
            const note = createElement('p', {
                class: 'no-print text-xs text-stone-400 mt-4 text-center',
                text: `Booked on ${formatDate(booking.createdAt)}`,
            });
            body.appendChild(note);
        }

        /** Builds a two column label/value block. */
        function detailRow(label, fields) {
            const wrap = createElement('div', { class: 'py-4 border-b border-stone-100' });
            wrap.appendChild(createElement('p', { class: 'text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2', text: label }));

            const grid = createElement('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-4' });
            for (const field of fields) {
                const cell = document.createElement('div');
                cell.appendChild(createElement('p', { class: 'text-xs text-stone-500', text: field.label }));
                cell.appendChild(createElement('p', { class: 'text-sm font-medium text-stone-900 mt-0.5', text: field.value }));
                grid.appendChild(cell);
            }

            wrap.appendChild(grid);
            return wrap;
        }

        async function cancelBooking(booking) {
            const confirmed = await confirmDialog({
                title: 'Cancel this booking?',
                message: `Booking ${booking.bookingReference} will be cancelled and the room released. This cannot be undone.`,
                confirmLabel: 'Yes, cancel booking',
                variant: 'danger',
            });

            if (!confirmed) return;

            try {
                await api.post(`/bookings/${booking.id}/cancel`, { reason: 'Cancelled by guest' });
                notify.success('Booking cancelled.');
                // Reload so the page shows the new status rather than the old card.
                history.replaceState(null, '', `?id=${booking.id}`);
                load();
            } catch (error) {
                notify.error(error.message);
            }
        }

        await load();
    }
}