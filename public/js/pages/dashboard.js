/**
 * public/js/pages/dashboard.js
 *
 * WHAT THIS MODULE DOES
 * The guest dashboard: summary cards, the next upcoming booking, recent
 * activity and quick actions.
 *
 * WHY IT EXISTS
 * The dashboard is the first thing a guest sees after signing in. It answers
 * three questions immediately: when is my stay, what have I ordered, and what
 * do I owe.
 *
 * COMMUNICATION
 * Page -> this module -> buildShell() for layout
 *                   -> /api/bookings/summary for the cards
 *                   -> /api/orders for recent orders
 *                   -> /api/notifications/unread-count
 */
import { buildShell, addHeaderAction } from '../components/shell.js';
import { statCard, bookingCard } from '../components/cards.js';
import api from '../api/api.js';
import notify from '../components/notification.js';
import {
    createElement,
    formatMoney,
    formatDate,
    showSkeleton,
    showEmptyState,
    getQueryParam,
} from '../lib/dom.js';

const shell = await buildShell({
    title: 'Dashboard',
    subtitle: 'Your stay at a glance',
});

if (shell?.content) {
    const { user, content } = shell;

    // Welcome message after registering, so the account creation feels
    // acknowledged rather than silent.
    if (getQueryParam('welcome')) {
        notify.success(`Welcome, ${user.firstName}. Your account is ready.`, { title: 'Account created' });
    }

    addHeaderAction({
        label: 'Book a room',
        icon: 'fa-plus',
        variant: 'primary',
        href: '/pages/guest/rooms.html',
    });

    // =====================================================================
    // Summary cards
    // =====================================================================
    const cardsGrid = createElement('div', {
        class: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-6',
        id: 'summary-cards',
    });
    content.appendChild(cardsGrid);
    showSkeleton(cardsGrid, 4, 'h-24');

    // =====================================================================
    // Two column body: upcoming stay and recent activity
    // =====================================================================
    const columns = createElement('div', { class: 'grid gap-6 lg:grid-cols-3' });

    const upcomingColumn = createElement('div', { class: 'lg:col-span-2' });
    const activityColumn = createElement('div');

    // ---- Upcoming booking ----
    const upcomingCard = createElement('section', { class: 'card' });
    const upcomingHeader = createElement('div', { class: 'card-header flex items-center justify-between' });
    upcomingHeader.appendChild(createElement('h2', { class: 'font-semibold text-stone-900', text: 'Your next stay' }));

    const viewAll = createElement('a', {
        href: '/pages/guest/bookings.html',
        class: 'text-sm text-amber-700 hover:underline',
        text: 'All bookings',
    });
    upcomingHeader.appendChild(viewAll);
    upcomingCard.appendChild(upcomingHeader);

    const upcomingBody = createElement('div', { class: 'card-body', id: 'upcoming-booking' });
    upcomingCard.appendChild(upcomingBody);
    upcomingColumn.appendChild(upcomingCard);

    // ---- Recent orders ----
    const ordersCard = createElement('section', { class: 'card mt-6' });
    const ordersHeader = createElement('div', { class: 'card-header flex items-center justify-between' });
    ordersHeader.appendChild(createElement('h2', { class: 'font-semibold text-stone-900', text: 'Recent orders' }));

    const orderAll = createElement('a', {
        href: '/pages/guest/orders.html',
        class: 'text-sm text-amber-700 hover:underline',
        text: 'All orders',
    });
    ordersHeader.appendChild(orderAll);
    ordersCard.appendChild(ordersHeader);

    const ordersBody = createElement('div', { class: 'card-body', id: 'recent-orders' });
    ordersCard.appendChild(ordersBody);
    upcomingColumn.appendChild(ordersCard);

    // ---- Activity column ----
    const notificationsCard = createElement('section', { class: 'card' });
    notificationsCard.appendChild(
        createElement('div', { class: 'card-header', text: '' }, [
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Notifications' }),
        ]),
    );
    const notificationsBody = createElement('div', { class: 'card-body p-0 divide-y divide-stone-100', id: 'recent-notifications' });
    notificationsCard.appendChild(notificationsBody);
    activityColumn.appendChild(notificationsCard);

    // ---- Quick actions ----
    const quickCard = createElement('section', { class: 'card mt-6' });
    quickCard.appendChild(
        createElement('div', { class: 'card-header' }, [
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Quick actions' }),
        ]),
    );

    const quickBody = createElement('div', { class: 'card-body space-y-2' });
    const QUICK_ACTIONS = [
        { href: '/pages/guest/rooms.html', icon: 'fa-bed', label: 'Book another room' },
        { href: '/pages/guest/restaurant.html', icon: 'fa-utensils', label: 'Order food' },
        { href: '/pages/guest/messages.html', icon: 'fa-comments', label: 'Message reception' },
        { href: '/pages/guest/payments.html', icon: 'fa-credit-card', label: 'Pay an outstanding balance' },
    ];

    for (const action of QUICK_ACTIONS) {
        const link = createElement('a', {
            href: action.href,
            class: 'flex items-center gap-3 p-3 rounded-lg border border-stone-200 hover:border-amber-400 hover:bg-amber-50/40 transition',
        });

        const iconWrap = createElement('span', {
            class: 'flex items-center justify-center w-9 h-9 rounded-lg bg-stone-100 text-stone-600 shrink-0',
        }, [createElement('i', { class: `fa-solid ${action.icon}`, 'aria-hidden': 'true' })]);

        link.append(iconWrap, createElement('span', { class: 'text-sm font-medium text-stone-800', text: action.label }));
        quickBody.appendChild(link);
    }

    quickCard.appendChild(quickBody);
    activityColumn.appendChild(quickCard);

    columns.append(upcomingColumn, activityColumn);
    content.appendChild(columns);

    // =====================================================================
    // Data loading
    // Each request is independent, so a failure in one does not blank the
    // whole dashboard. Each handler owns its own error state.
    // =====================================================================

    // ---- Summary cards ----
    async function loadSummary() {
        try {
            const result = await api.get('/bookings/summary');
            const summary = result?.data?.summary || {};

            cardsGrid.textContent = '';
            cardsGrid.append(
                statCard({
                    label: 'Upcoming booking',
                    value: summary.upcoming ?? 0,
                    icon: 'fa-calendar-check',
                    tone: 'accent',
                    hint: 'confirmed or awaiting confirmation',
                }),
                statCard({
                    label: 'Total bookings',
                    value: summary.totalBookings ?? 0,
                    icon: 'fa-calendar',
                    tone: 'info',
                    hint: `${summary.completed ?? 0} completed`,
                }),
                statCard({
                    label: 'Total spent',
                    value: formatMoney(summary.totalSpent ?? 0),
                    icon: 'fa-wallet',
                    tone: 'neutral',
                    hint: 'across all bookings',
                }),
                statCard({
                    label: 'Outstanding balance',
                    value: formatMoney(summary.outstandingBalance ?? 0),
                    icon: 'fa-circle-exclamation',
                    // Green when nothing is owed, amber when there is.
                    tone: Number(summary.outstandingBalance) > 0 ? 'warning' : 'success',
                    hint: Number(summary.outstandingBalance) > 0 ? 'payment due' : 'all settled',
                    href: '/pages/guest/payments.html',
                }),
            );
        } catch (error) {
            cardsGrid.textContent = '';
            showEmptyState(cardsGrid, {
                title: 'Could not load your summary',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    // ---- Next booking ----
    async function loadUpcoming() {
        showSkeleton(upcomingBody, 1, 'h-32');

        try {
            const result = await api.get('/bookings/summary');
            const booking = result?.data?.nextBooking;

            if (!booking) {
                showEmptyState(upcomingBody, {
                    title: 'No upcoming stay',
                    message: 'You have no reservation planned yet.',
                    icon: 'fa-calendar-plus',
                    actionHtml:
                        '<a href="/pages/guest/rooms.html" class="btn btn-primary">Browse rooms</a>',
                });
                return;
            }

            upcomingBody.textContent = '';
            upcomingBody.appendChild(
                bookingCard(booking, {
                    cancel: {
                        label: 'Cancel booking',
                        icon: 'fa-xmark',
                        variant: 'outline',
                        onClick: () => cancelBooking(booking),
                    },
                }),
            );
        } catch (error) {
            showEmptyState(upcomingBody, {
                title: 'Could not load your booking',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    // ---- Cancels a booking, confirming first ----
    async function cancelBooking(booking) {
        const { confirmDialog } = await import('../components/modal.js');

        const confirmed = await confirmDialog({
            title: 'Cancel this booking?',
            message: `Booking ${booking.bookingReference} for ${formatDate(booking.checkIn)} will be cancelled and the room released. This cannot be undone.`,
            confirmLabel: 'Yes, cancel booking',
            variant: 'danger',
        });

        if (!confirmed) return;

        try {
            await api.post(`/bookings/${booking.id}/cancel`, { reason: 'Cancelled by guest' });
            notify.success('Booking cancelled. The room has been released.');
            loadUpcoming();
            loadSummary();
        } catch (error) {
            notify.error(error.message);
        }
    }

    // ---- Recent orders ----
    async function loadOrders() {
        showSkeleton(ordersBody, 2, 'h-16');

        try {
            const result = await api.get('/orders', { query: { limit: 4 } });
            const orders = result?.data?.orders || [];

            if (orders.length === 0) {
                showEmptyState(ordersBody, {
                    title: 'No orders yet',
                    message: 'Order from the restaurant or arrange room service.',
                    icon: 'fa-utensils',
                    actionHtml: '<a href="/pages/guest/restaurant.html" class="btn btn-primary">View the menu</a>',
                });
                return;
            }

            ordersBody.textContent = '';

            for (const order of orders) {
                const row = createElement('a', {
                    href: `/pages/guest/order-details.html?id=${order.id}`,
                    class: 'flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:bg-stone-50 rounded px-2 -mx-2 transition',
                });

                const left = document.createElement('div');
                left.className = 'min-w-0';

                left.appendChild(
                    createElement('p', { class: 'text-sm font-medium text-stone-900 font-mono', text: order.orderReference }),
                );
                left.appendChild(
                    createElement('p', {
                        class: 'text-xs text-stone-500',
                        text: `${formatDate(order.placed_at || order.createdAt)} - ${order.fulfilment_type === 'room_delivery' ? 'Room delivery' : 'Pickup'}`,
                    }),
                );

                const right = document.createElement('div');
                right.className = 'text-right shrink-0';
                right.appendChild(createElement('p', { class: 'text-sm font-semibold text-stone-900', text: formatMoney(order.totalAmount) }));

                row.append(left, right);
                ordersBody.appendChild(row);
            }
        } catch (error) {
            showEmptyState(ordersBody, {
                title: 'Could not load orders',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    // ---- Notifications ----
    async function loadNotifications() {
        showSkeleton(notificationsBody, 3, 'h-14');

        try {
            const result = await api.get('/notifications', { query: { limit: 5 } });
            const notifications = result?.data?.notifications || [];

            if (notifications.length === 0) {
                notificationsBody.appendChild(
                    createElement('p', { class: 'text-sm text-stone-500 p-5 text-center', text: 'No notifications yet.' }),
                );
                return;
            }

            notificationsBody.textContent = '';

            for (const notification of notifications) {
                const row = createElement('div', {
                    class: 'flex items-start gap-3 p-4 hover:bg-stone-50 transition',
                });

                // Unread items are marked with a dot and bold text.
                const dot = createElement('span', {
                    class: notification.isRead ? 'w-2 h-2 rounded-full bg-transparent mt-2 shrink-0' : 'w-2 h-2 rounded-full bg-amber-500 mt-2 shrink-0',
                    'aria-hidden': 'true',
                });

                const body = document.createElement('div');
                body.className = 'min-w-0';

                body.appendChild(
                    createElement('p', {
                        class: notification.isRead ? 'text-sm text-stone-700' : 'text-sm font-semibold text-stone-900',
                        text: notification.title,
                    }),
                );
                if (notification.body) {
                    body.appendChild(
                        createElement('p', { class: 'text-xs text-stone-500 mt-0.5 line-clamp-2', text: notification.body }),
                    );
                }

                row.append(dot, body);
                notificationsBody.appendChild(row);
            }
        } catch (error) {
            notificationsBody.textContent = '';
            notificationsBody.appendChild(
                createElement('p', { class: 'text-sm text-stone-500 p-5 text-center', text: 'Could not load notifications.' }),
            );
        }
    }

    // Load everything in parallel.
    await Promise.all([
        loadSummary(),
        loadUpcoming(),
        loadOrders(),
        loadNotifications(),
    ]);
}