/**
 * public/js/pages/guest/notifications.js
 *
 * WHAT THIS MODULE DOES
 * The guest's notification feed, with mark-as-read and a clear-all.
 *
 * WHY CLICKING A NOTIFICATION FOLLOWS ITS LINK
 * Each notification carries the URL it refers to, so the natural expectation is
 * that clicking the item takes you to the booking or order it is about. Marking
 * it read is a side effect of that click rather than a separate action, which is
 * why the whole row is the button.
 *
 * COMMUNICATION
 * Page -> GET    /api/notifications
 *      -> PATCH  /api/notifications/:id/read | /read-all
 *      -> DELETE /api/notifications/:id | /
 * Database tables used: notifications
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { createListController, createToolbar, actionButtons, confirmAndRun } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import { createElement, formatDate } from '../../lib/dom.js';

/** Icon per notification type, so the feed is scannable at a glance. */
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
    new_message: 'fa-comment',
};

const shell = await buildShell({
    title: 'Notifications',
    subtitle: 'Everything the hotel has told you',
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
        limit: 20,
        empty: {
            title: 'Nothing here yet',
            message: 'Booking updates, orders and payments will appear here.',
            icon: 'fa-bell',
        },
        render(rows, { slot }) {
            const list = createElement('div', {
                class: 'bg-white rounded-xl border border-stone-200 shadow-sm divide-y divide-stone-100',
            });

            for (const item of rows) {
                list.appendChild(notificationRow(item));
            }

            slot.appendChild(list);
        },
    });

    function notificationRow(item) {
        const link = item.data?.url;
        const row = createElement('article', {
            class: `flex items-start gap-3 p-4 ${item.isRead ? '' : 'bg-amber-50/50'}`,
        });

        const icon = createElement('span', {
            class: `flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${
                item.isRead ? 'bg-stone-100 text-stone-400' : 'bg-amber-100 text-amber-700'
            }`,
        });
        icon.appendChild(
            createElement('i', { class: `fa-solid ${ICONS[item.type] || 'fa-bell'}`, 'aria-hidden': 'true' }),
        );

        const body = createElement('div', { class: 'flex-1 min-w-0' });

        // The title is the link when the notification knows where it points,
        // so the row does not need a separate "go" button.
        if (link) {
            const anchor = createElement('a', {
                href: link,
                class: 'block hover:underline',
                text: item.title,
            });
            anchor.addEventListener('click', () => {
                if (!item.isRead) markRead(item);
            });
            body.appendChild(anchor);
        } else {
            body.appendChild(
                createElement('p', {
                    class: item.isRead ? 'text-stone-700' : 'font-semibold text-stone-900',
                    text: item.title,
                }),
            );
        }

        if (item.body) {
            body.appendChild(createElement('p', { class: 'text-xs text-stone-500 mt-0.5', text: item.body }));
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
            message: 'All of them will be removed. This cannot be undone.',
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
