/**
 * public/js/pages/staff/reception.js
 *
 * WHAT THIS MODULE DOES
 * The front desk: today's arrivals, today's departures and who is currently in
 * house, each with the one action that booking is waiting for.
 *
 * WHY IT EXISTS
 * A receptionist's day is three short lists, not one long list filtered by
 * status. Splitting them means the question "who is arriving?" has its own
 * screen instead of being a filter that has to be remembered and reset.
 *
 * WHY THE ACTIONS ARE PER-STATUS
 * Confirm, check in and check out are only offered where they are meaningful.
 * Showing "check in" on a cancelled booking invites a mistake that the API then
 * has to reject, which wastes the receptionist's time and trains them to ignore
 * error messages.
 *
 * COMMUNICATION
 * Page -> GET /api/bookings/front-desk   (the three panels)
 *      -> GET /api/bookings/counts       (header counters)
 *      -> POST /api/bookings/:id/confirm | check-in | check-out
 * Database tables used: bookings, rooms, guests
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { statCard } from '../../components/cards.js';
import { confirmAndRun, actionButtons } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showEmptyState,
    showSkeleton,
    formatDate,
    statusBadge,
} from '../../lib/dom.js';

const STAFF_ROLES = ['receptionist', 'manager', 'admin'];

const shell = await buildShell({
    title: 'Front desk',
    subtitle: 'Arrivals, departures and guests in house',
    roles: STAFF_ROLES,
});

if (shell?.content) {
    const { content } = shell;

    addHeaderAction({
        label: 'Refresh',
        icon: 'fa-rotate',
        variant: 'outline',
        href: '#',
        onClick: (event) => {
            event.preventDefault();
            loadAll();
        },
    });

    // =====================================================================
    // Counters
    // =====================================================================
    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    // =====================================================================
    // Panels
    // =====================================================================
    const panelGrid = createElement('div', { class: 'grid grid-cols-1 xl:grid-cols-3 gap-6' });
    content.appendChild(panelGrid);

    const panels = [
        { key: 'arrivals', title: 'Arrivals today', icon: 'fa-plane-arrival', empty: 'No arrivals booked for today.' },
        { key: 'departures', title: 'Departures today', icon: 'fa-plane-departure', empty: 'No departures due today.' },
        { key: 'inHouse', title: 'Currently in house', icon: 'fa-bed', empty: 'No guests are currently checked in.' },
    ].map((definition) => {
        const body = createElement('div', { class: 'p-3 space-y-3' });
        const card = createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${definition.icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: definition.title }),
            ]),
            body,
        ]);

        panelGrid.appendChild(card);
        return { ...definition, body };
    });

    // =====================================================================
    // Data
    // =====================================================================
    let counts = {};

    async function loadCounts() {
        try {
            const result = await api.get('/bookings/counts');
            counts = result?.data?.counts || {};
        } catch {
            // A missing counter must not blank the page; the panels are the
            // part the receptionist actually works from.
            counts = {};
        }

        clear(statsRow);

        // The arrivals and departures counts are derived from the front desk
        // panels rather than from /bookings/counts, which only breaks bookings
        // down by status. Showing "6" while the arrivals panel lists 6 rows is
        // what makes a counter trustworthy.
        const arrivals = panels[0].count ?? 0;
        const departures = panels[1].count ?? 0;
        const inHouse = panels[2].count ?? 0;

        statsRow.append(
            statCard({ label: 'Arriving today', value: arrivals, icon: 'fa-plane-arrival', tone: 'info' }),
            statCard({ label: 'Departing today', value: departures, icon: 'fa-plane-departure', tone: 'warning' }),
            statCard({ label: 'In house', value: inHouse, icon: 'fa-bed', tone: 'success' }),
            statCard({
                label: 'Awaiting confirmation',
                value: counts.pending ?? 0,
                icon: 'fa-hourglass-half',
                tone: 'neutral',
            }),
        );
    }

    async function loadFrontDesk() {
        for (const panel of panels) showSkeleton(panel.body, 2, 'h-20');

        try {
            const result = await api.get('/bookings/front-desk');
            const data = result?.data || {};

            for (const panel of panels) {
                const bookings = data[panel.key] || [];
                panel.count = bookings.length;
                clear(panel.body);
                panel.body.removeAttribute('aria-busy');

                if (bookings.length === 0) {
                    const holder = createElement('div');
                    panel.body.appendChild(holder);
                    showEmptyState(holder, {
                        title: 'Nothing here',
                        message: panel.empty,
                        icon: panel.icon,
                    });
                    continue;
                }

                for (const booking of bookings) {
                    panel.body.appendChild(bookingRow(booking));
                }
            }
        } catch (error) {
            for (const panel of panels) {
                clear(panel.body);
                showEmptyState(panel.body, {
                    title: 'Could not load',
                    message: error.message,
                    icon: 'fa-triangle-exclamation',
                });
            }
        }
    }

    /** One guest card with the single action that booking is waiting for. */
    function bookingRow(booking) {
        const card = createElement('article', { class: 'border border-stone-200 rounded-lg p-3' });

        const top = createElement('div', { class: 'flex items-start justify-between gap-2 mb-2' });
        const identity = createElement('div', { class: 'min-w-0' });
        identity.append(
            createElement('p', { class: 'font-medium text-stone-900 truncate', text: booking.guestName || 'Guest' }),
            createElement('p', { class: 'text-xs text-stone-500 truncate', text: booking.bookingReference || '' }),
        );
        top.append(identity, statusBadge(booking.status));

        const detail = createElement('div', { class: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600 mb-3' });
        detail.append(
            detailItem('fa-bed', `Room ${booking.roomNumber ?? '-'}`),
            detailItem('fa-calendar', formatDate(booking.checkIn)),
            detailItem('fa-users', `${booking.guests || 1} guest${booking.guests === 1 ? '' : 's'}`),
        );

        const footer = createElement('div', { class: 'flex items-center justify-between gap-2' });
        if (Number(booking.balanceDue) > 0) {
            footer.appendChild(
                createElement('span', {
                    class: 'text-xs font-medium text-red-600',
                    text: `Balance due $${Number(booking.balanceDue).toFixed(2)}`,
                }),
            );
        }

        const actions = actionsFor(booking);
        if (actions) footer.appendChild(actions);

        card.append(top, detail, footer);
        return card;
    }

    function detailItem(icon, text) {
        const span = createElement('span', { class: 'inline-flex items-center gap-1' });
        span.append(
            createElement('i', { class: `fa-solid ${icon} text-stone-400`, 'aria-hidden': 'true' }),
            createElement('span', { text }),
        );
        return span;
    }

    /**
     * The actions valid for a booking's status.
     *
     * A pending booking can be confirmed or cancelled; a confirmed one can be
     * checked in or cancelled; a checked-in one can only be checked out. Each
     * transition is a separate endpoint, so an action that the API would reject
     * is simply not offered.
     */
    function actionsFor(booking) {
        const acts = [];

        if (booking.status === 'pending') {
            acts.push({
                icon: 'fa-check',
                label: 'Confirm booking',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'confirm', 'Confirm this booking?'),
            });
            acts.push({
                icon: 'fa-xmark',
                label: 'Cancel booking',
                className: 'btn btn-ghost btn-sm',
                onClick: () => transition(booking, 'cancel', 'Cancel this booking? The room is released.'),
            });
        } else if (booking.status === 'confirmed') {
            acts.push({
                icon: 'fa-door-open',
                label: 'Check in',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'check-in', `Check ${booking.guestName} in?`),
            });
            acts.push({
                icon: 'fa-xmark',
                label: 'Cancel booking',
                className: 'btn btn-ghost btn-sm',
                onClick: () => transition(booking, 'cancel', 'Cancel this booking? The room is released.'),
            });
        } else if (booking.status === 'checked_in') {
            acts.push({
                icon: 'fa-door-closed',
                label: 'Check out',
                className: 'btn btn-primary btn-sm',
                onClick: () => transition(booking, 'check-out', `Check ${booking.guestName} out?`),
            });
        }

        return acts.length ? actionButtons(acts) : null;
    }

    /** Runs a status transition behind a confirmation. */
    async function transition(booking, action, question) {
        const done = await confirmAndRun({
            title: question,
            message:
                action === 'cancel'
                    ? `Booking ${booking.bookingReference} for ${booking.guestName} will be cancelled. This cannot be undone.`
                    : `Booking ${booking.bookingReference} for ${booking.guestName}.`,
            confirmLabel: 'Yes, continue',
            variant: action === 'cancel' ? 'danger' : 'primary',
            run: async () => {
                if (action === 'cancel') {
                    await api.post(`/bookings/${booking.id}/cancel`, {
                        reason: 'Cancelled by the front desk',
                    });
                } else {
                    await api.post(`/bookings/${booking.id}/${action}`, {});
                }
            },
        });

        if (done) {
            notify.success(`Booking ${action === 'check-in' ? 'checked in' : action === 'check-out' ? 'checked out' : `${action}ed`}.`);
            loadAll();
        }
    }

    async function loadAll() {
        // Sequential on purpose: the arrival and departure counters are derived
        // from the panels, so the panels must be counted before the cards are
        // drawn. Running both at once would render the counters as zero on
        // first paint.
        await loadFrontDesk();
        await loadCounts();
    }

    await loadAll();
}
