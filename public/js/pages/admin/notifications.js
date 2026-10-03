/**
 * public/js/pages/admin/notifications.js
 *
 * WHAT THIS MODULE DOES
 * The signed-in user's own notifications, with mark-as-read and clear-all.
 *
 * WHY THIS IS THE ADMINISTRATOR'S OWN INBOX
 * The API is scoped to the session user by design: there is no endpoint that
 * returns somebody else's notifications. An administrator managing accounts for
 * other people still reads their own alerts here, which is what the notifications
 * service actually produces.
 *
 * WHY UNREAD IS COUNTED FROM THE SERVER
 * The unread badge comes from the server's own count rather than from counting
 * rows in the browser, so it stays correct when the list is filtered or paged.
 *
 * COMMUNICATION
 * Page -> GET    /api/notifications
 *      -> GET    /api/notifications/unread-count
 *      -> PATCH  /api/notifications/:id/read | /read-all
 *      -> DELETE /api/notifications/:id | /
 * Database tables used: notifications
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import {
    createListController,
    createToolbar,
    actionButtons,
    confirmAndRun,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import { createElement, formatDate } from '../../lib/dom.js';

const ROLES = ['manager', 'admin', 'receptionist', 'restaurant_staff', 'housekeeping'];

/** Icon per notification type, so the feed is scannable. */
const ICONS = {
    booking_confirmation: 'fa-calendar-check',
    booking_confirmed: 'fa-calendar-check',
    booking_cancelled: 'fa-calendar-xmark',
    checked_in: 'fa-door-open',
    checked_out: 'fa-door-closed',
    order_placed: 'fa-utensils',
    order_status: 'fa-bell-concierge',
    payment_completed: 'fa-circle-check',
    payment_failure: 'fa-circle-exclamation',
    review_response: 'fa-star',
    review_hidden: 'fa-eye-slash',
    chat_message: 'fa-comment',
};

const shell = await buildShell({
    title: 'Notifications',
    subtitle: 'Alerts raised for your account',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    addHeaderAction({
        label: 'Mark all read',
        icon: 'fa-check-double',
        variant: 'outline',
        href: '#',
        onClick: (event) => {
            event.preventDefault();
            markAllRead();
        },
    });

    addHeaderAction({
        label: 'Clear all',
        icon: 'fa-trash',
        variant: 'ghost',
        href: '#',
        onClick: (event) => {
            event.preventDefault();
            clearAll();
        },
    });

    content.appendChild(
        createToolbar(
            [
                {
                    type: 'select',
                    name: 'unreadOnly',
                    label: 'Show',
                    options: [
                        { value: '', label: 'All notifications' },
                        { value: 'true', label: 'Unread only' },
                    ],
                },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const controller = createListController({
        endpoint: '/notifications',
        container: listHost,
        state: { unreadOnly: '' },
        limit: 25,
        empty: {
            title: 'Nothing here',
            message: 'Booking updates, orders and payments will appear here.',
            icon: 'fa-bell',
        },
        render(rows, { slot }) {
            const list = createElement('div', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm divide-y divide-stone-100' });

            for (const item of rows) {
                list.appendChild(notificationRow(item));
            }

            slot.appendChild(list);
        },
    });

    function notificationRow(item) {
        const row = createElement('article', {
            class: `flex items-start gap-3 p-4 ${item.isRead ? '' : 'bg-amber-50/50'}`,
        });

        const icon = createElement('span', {
            class: `flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${
                item.isRead ? 'bg-stone-100 text-stone-400' : 'bg-amber-100 text-amber-700'
            }`,
        });
        icon.appendChild(
            createElement('i', {
                class: `fa-solid ${ICONS[item.type] || 'fa-bell'}`,
                'aria-hidden': 'true',
            }),
        );

        const body = createElement('div', { class: 'flex-1 min-w-0' });
        body.appendChild(
            createElement('p', {
                class: `text-sm ${item.isRead ? 'text-stone-700' : 'font-semibold text-stone-900'}`,
                text: item.title,
            }),
        );
        if (item.body) {
            body.appendChild(
                createElement('p', { class: 'text-xs text-stone-500 mt-0.5', text: item.body }),
            );
        }
        body.appendChild(
            createElement('p', { class: 'text-[11px] text-stone-400 mt-1', text: formatDate(item.createdAt) }),
        );

        const actions = actionButtons([
            ...(item.isRead
                ? []
                : [
                      {
                          icon: 'fa-check',
                          label: 'Mark as read',
                          className: 'btn btn-ghost btn-sm',
                          onClick: () => markRead(item),
                      },
                  ]),
            {
                icon: 'fa-trash',
                label: 'Delete notification',
                className: 'btn btn-ghost btn-sm',
                onClick: () => remove(item),
            },
        ]);

        row.append(icon, body, actions);
        return row;
    }

    async function markRead(item) {
        try {
            await api.patch(`/notifications/${item.id}/read`);
            controller.load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function markAllRead() {
        try {
            await api.patch('/notifications/read-all');
            notify.success('All notifications marked as read.');
            controller.load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function remove(item) {
        try {
            await api.delete(`/notifications/${item.id}`);
            controller.load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function clearAll() {
        const done = await confirmAndRun({
            title: 'Delete every notification?',
            message: 'All of your notifications will be removed. This cannot be undone.',
            confirmLabel: 'Delete them all',
            run: () => api.delete('/notifications'),
        });

        if (done) {
            notify.success('Notifications cleared.');
            controller.load();
        }
    }

    await controller.load();
}
