/**
 * public/js/pages/bookings.js
 *
 * WHAT THIS MODULE DOES
 * The guest's booking history and upcoming stays, with status filtering and
 * cancellation.
 *
 * WHY IT EXISTS
 * Guests need to see everything they have booked, what state each reservation
 * is in, and be able to cancel. Status filters are applied by the API rather
 * than by hiding rows in the browser, so the counts match the database.
 *
 * COMMUNICATION
 * Page -> /api/bookings (list, filtered and paginated by the server)
 *      -> POST /api/bookings/:id/cancel (cancellation)
 */
import { buildShell } from '../components/shell.js';
import { bookingCard, pagination } from '../components/cards.js';
import { confirmDialog } from '../components/modal.js';
import notify from '../components/notification.js';
import api from '../api/api.js';
import {
    createElement,
    showSkeleton,
    showEmptyState,
    formatDate,
    getQueryParam,
} from '../lib/dom.js';

const shell = await buildShell({
    title: 'My bookings',
    subtitle: 'Your reservations and stay history',
});

if (shell?.content) {
    const { content } = shell;

    // =====================================================================
    // Status filters
    // =====================================================================
    const FILTERS = [
        { value: '', label: 'All' },
        { value: 'pending', label: 'Pending' },
        { value: 'confirmed', label: 'Confirmed' },
        { value: 'checked_in', label: 'In house' },
        { value: 'checked_out', label: 'Completed' },
        { value: 'cancelled', label: 'Cancelled' },
    ];

    const filterBar = createElement('div', { class: 'flex flex-wrap gap-2 mb-6' });
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter bookings by status');

    for (const filter of FILTERS) {
        const button = createElement('button', {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            text: filter.label,
            'aria-pressed': 'false',
            'data-filter': filter.value,
        });
        button.addEventListener('click', () => {
            state.status = filter.value;
            state.page = 1;
            highlightFilter();
            load();
        });
        filterBar.appendChild(button);
    }

    content.appendChild(filterBar);

    function highlightFilter() {
        for (const button of filterBar.querySelectorAll('[data-filter]')) {
            const active = button.dataset.filter === state.status;
            // Toggle between the two complete class literals.
            button.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
            button.setAttribute('aria-pressed', String(active));
        }
    }

    const list = createElement('div', { class: 'space-y-4', id: 'booking-list' });
    const paginationSlot = createElement('div', { id: 'booking-pagination', class: 'mt-6' });
    content.append(list, paginationSlot);

    const state = { page: 1, limit: 10, status: '', totalPages: 1 };

    // A status can be supplied in the URL, for example from the dashboard.
    const initialStatus = getQueryParam('status');
    if (FILTERS.some((filter) => filter.value === initialStatus)) {
        state.status = initialStatus;
    }
    highlightFilter();

    async function load() {
        showSkeleton(list, 3, 'h-40');

        try {
            const result = await api.get('/bookings', {
                query: {
                    page: state.page,
                    limit: state.limit,
                    status: state.status || undefined,
                },
            });

            const bookings = result?.data || [];
            state.totalPages = result?.meta?.totalPages || 1;

            if (bookings.length === 0) {
                showEmptyState(list, {
                    title: state.status ? `No ${state.status.replace('_', ' ')} bookings` : 'No bookings yet',
                    message: state.status
                        ? 'Try a different status filter.'
                        : 'When you book a room it will appear here with its confirmation details.',
                    icon: 'fa-calendar',
                    actionHtml: state.status
                        ? ''
                        : '<a href="/pages/guest/rooms.html" class="btn btn-primary">Browse rooms</a>',
                });
                paginationSlot.textContent = '';
                return;
            }

            list.textContent = '';

            for (const booking of bookings) {
                list.appendChild(buildCard(booking));
            }

            paginationSlot.textContent = '';
            paginationSlot.appendChild(
                pagination({
                    page: state.page,
                    totalPages: state.totalPages,
                    total: result?.meta?.total || 0,
                    onChange: (page) => {
                        state.page = page;
                        load();
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    },
                }),
            );
        } catch (error) {
            showEmptyState(list, {
                title: 'Could not load your bookings',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    /** Builds the card with whichever actions are valid for its status. */
    function buildCard(booking) {
        const actions = {};

        // Only a booking that has not started can be cancelled. A completed
        // stay is settled, and a checked-in guest must go through checkout.
        if (['pending', 'confirmed'].includes(booking.status)) {
            actions.cancel = {
                label: 'Cancel booking',
                icon: 'fa-xmark',
                variant: 'outline',
                onClick: () => cancelBooking(booking),
            };
        }

        if (booking.balanceDue > 0 && ['confirmed', 'checked_in', 'checked_out'].includes(booking.status)) {
            actions.pay = {
                label: 'Pay balance',
                icon: 'fa-credit-card',
                variant: 'primary',
                onClick: () => {
                    window.location.href = `/pages/guest/payments.html?bookingId=${booking.id}`;
                },
            };
        }

        return bookingCard(booking, actions);
    }

    async function cancelBooking(booking) {
        const confirmed = await confirmDialog({
            title: 'Cancel this booking?',
            message: `Booking ${booking.bookingReference} for ${formatDate(booking.checkIn)} will be cancelled and the room released. This cannot be undone.`,
            confirmLabel: 'Yes, cancel booking',
            variant: 'danger',
        });

        if (!confirmed) return;

        try {
            await api.post(`/bookings/${booking.id}/cancel`, { reason: 'Cancelled by guest' });
            notify.success('Booking cancelled.');
            load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    await load();
}