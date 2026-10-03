/**
 * public/js/pages/admin/reviews.js
 *
 * WHAT THIS MODULE DOES
 * Review moderation: every guest review, with staff replies and controls to
 * hide, flag or delete one.
 *
 * WHY HIDE RATHER THAN DELETE IS THE DEFAULT ACTION
 * Deleting a review destroys the record of what a guest said. Hiding takes it
 * out of public view while keeping it, which is almost always what a manager
 * wants when a review is unfair but not abusive. Delete is still offered, and is
 * the more destructive of the two, so it is the one behind a confirmation.
 *
 * WHY THE STATISTICS EXCLUDE HIDDEN REVIEWS
 * The average shown here must match the average a guest sees, otherwise
 * moderating a review would appear to change the hotel's score, which it does
 * not. The API computes it that way, and this page does not adjust it.
 *
 * COMMUNICATION
 * Page -> GET    /api/reviews/stats
 *      -> GET    /api/reviews/moderation   (includes hidden)
 *      -> POST   /api/reviews/:id/reply
 *      -> PATCH  /api/reviews/:id/visibility | /flag
 *      -> DELETE /api/reviews/:id
 * Database tables used: reviews, users
 */
import { buildShell } from '../../components/shell.js';
import { statCard } from '../../components/cards.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    openFormModal,
    actionButtons,
    confirmAndRun,
    personCell,
    dateCell,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import { createElement, clear, formatRating, formatNumber } from '../../lib/dom.js';

const ROLES = ['receptionist', 'manager', 'admin'];

const ENTITY_TYPES = [
    { value: '', label: 'All types' },
    { value: 'hotel', label: 'Hotel' },
    { value: 'room', label: 'Room' },
    { value: 'restaurant', label: 'Restaurant' },
    { value: 'food_item', label: 'Food item' },
    { value: 'service', label: 'Service' },
];

const RATINGS = [
    { value: '', label: 'All ratings' },
    { value: '5', label: '5 stars' },
    { value: '4', label: '4 stars' },
    { value: '3', label: '3 stars' },
    { value: '2', label: '2 stars' },
    { value: '1', label: '1 star' },
];

/** Renders the five stars as text plus a number, which screen readers read well. */
function stars(rating) {
    return createElement('span', {
        class: 'text-sm whitespace-nowrap',
        text: `${'★'.repeat(Number(rating))}${'☆'.repeat(5 - Number(rating))} ${formatRating(rating)}`,
    });
}

const shell = await buildShell({
    title: 'Reviews',
    subtitle: 'Guest feedback and moderation',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    async function loadStats() {
        try {
            const result = await api.get('/reviews/stats');
            const stats = result?.data?.stats || {};

            clear(statsRow);
            statsRow.append(
                statCard({
                    label: 'Average rating',
                    value: formatRating(stats.average),
                    hint: `${formatNumber(stats.total)} visible review(s)`,
                    icon: 'fa-star',
                    tone: 'warning',
                }),
                statCard({
                    label: 'Five star',
                    value: formatNumber(stats.distribution?.[5] ?? 0),
                    icon: 'fa-thumbs-up',
                    tone: 'success',
                }),
                statCard({
                    label: 'One or two star',
                    value: formatNumber((stats.distribution?.[1] ?? 0) + (stats.distribution?.[2] ?? 0)),
                    icon: 'fa-thumbs-down',
                    tone: 'danger',
                }),
                statCard({
                    label: 'Flagged',
                    value: formatNumber(stats.flagged ?? 0),
                    icon: 'fa-flag',
                    tone: 'accent',
                }),
            );
        } catch {
            clear(statsRow);
        }
    }

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Title, comment or guest...' },
                { type: 'select', name: 'entityType', label: 'About', options: ENTITY_TYPES },
                { type: 'select', name: 'minRating', label: 'Rating', options: RATINGS },
                {
                    type: 'select',
                    name: 'flaggedOnly',
                    label: 'Flagged',
                    options: [
                        { value: '', label: 'All reviews' },
                        { value: 'true', label: 'Flagged only' },
                    ],
                },
                {
                    type: 'select',
                    name: 'includeHidden',
                    label: 'Visibility',
                    options: [
                        { value: '', label: 'Public view' },
                        { value: 'true', label: 'Include hidden' },
                    ],
                },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        { header: 'Rating', render: (review) => stars(review.rating) },
        {
            header: 'Review',
            render: (review) => {
                const wrap = createElement('div', { class: 'min-w-0 max-w-md' });
                wrap.appendChild(
                    createElement('p', { class: 'font-medium text-stone-900', text: review.title }),
                );
                wrap.appendChild(
                    createElement('p', {
                        class: 'text-xs text-stone-500 whitespace-pre-wrap',
                        text: review.comment,
                    }),
                );
                if (review.staffReply) {
                    wrap.appendChild(
                        createElement('p', {
                            class: 'text-xs text-amber-700 mt-2 border-l-2 border-amber-300 pl-2',
                            text: `Reply: ${review.staffReply}`,
                        }),
                    );
                }
                return wrap;
            },
        },
        {
            header: 'Guest',
            render: (review) => personCell(review.guestName, review.guestEmail),
        },
        {
            header: 'About',
            render: (review) =>
                createElement('span', {
                    class: 'text-sm capitalize',
                    text: review.entityLabel || String(review.entityType).replace('_', ' '),
                }),
        },
        {
            header: 'State',
            render: (review) => {
                const wrap = createElement('div', { class: 'flex flex-wrap gap-1' });
                wrap.appendChild(
                    review.isVisible
                        ? createElement('span', { class: 'badge badge-success', text: 'Public' })
                        : createElement('span', { class: 'badge badge-neutral', text: 'Hidden' }),
                );
                if (review.isFlagged) {
                    wrap.appendChild(createElement('span', { class: 'badge badge-danger', text: 'Flagged' }));
                }
                return wrap;
            },
        },
        { header: 'Posted', render: (review) => dateCell(review.createdAt) },
        { header: 'Actions', className: 'text-right', render: (review) => actionsFor(review) },
    ];

    const controller = createListController({
        endpoint: '/reviews/moderation',
        container: listHost,
        state: { search: '', entityType: '', minRating: '', flaggedOnly: '', includeHidden: '' },
        limit: 15,
        empty: {
            title: 'No reviews match',
            message: 'Guest reviews appear here once they have been written.',
            icon: 'fa-star',
        },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    function actionsFor(review) {
        return actionButtons([
            {
                icon: 'fa-reply',
                label: review.staffReply ? 'Edit reply' : 'Reply',
                className: 'btn btn-ghost btn-sm',
                onClick: () => reply(review),
            },
            {
                icon: review.isVisible ? 'fa-eye-slash' : 'fa-eye',
                label: review.isVisible ? 'Hide from public' : 'Show publicly',
                className: 'btn btn-ghost btn-sm',
                onClick: () => setVisibility(review),
            },
            {
                icon: 'fa-flag',
                label: review.isFlagged ? 'Remove flag' : 'Flag',
                className: 'btn btn-ghost btn-sm',
                onClick: () => setFlagged(review),
            },
            {
                icon: 'fa-trash',
                label: 'Delete review',
                className: 'btn btn-ghost btn-sm',
                onClick: () => remove(review),
            },
        ]);
    }

    async function reply(review) {
        const saved = await openFormModal({
            title: `Reply to "${review.title}"`,
            description: 'Your reply is published under the hotel name and the guest is notified.',
            submitLabel: 'Publish reply',
            fields: [
                {
                    name: 'reply',
                    label: 'Reply',
                    type: 'textarea',
                    rows: 5,
                    required: true,
                    value: review.staffReply || '',
                    placeholder: 'Thank the guest and address their concern...',
                },
            ],
            run: (values) => api.post(`/reviews/${review.id}/reply`, values),
        });

        if (saved) {
            notify.success('Reply published.');
            controller.load();
        }
    }

    async function setVisibility(review) {
        const next = !review.isVisible;
        const done = await confirmAndRun({
            title: next ? 'Show this review publicly?' : 'Hide this review?',
            message: next
                ? `"${review.title}" will appear on the public site again.`
                : `"${review.title}" will be removed from public view but kept in the system. The guest is notified.`,
            confirmLabel: next ? 'Show it' : 'Hide it',
            variant: next ? 'primary' : 'danger',
            run: () => api.patch(`/reviews/${review.id}/visibility`, { isVisible: next }),
        });

        if (done) {
            notify.success(next ? 'Review is now public.' : 'Review hidden.');
            controller.load();
            loadStats();
        }
    }

    async function setFlagged(review) {
        const next = !review.isFlagged;
        try {
            await api.patch(`/reviews/${review.id}/flag`, { isFlagged: next });
            notify.success(next ? 'Review flagged.' : 'Flag removed.');
            controller.load();
            loadStats();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function remove(review) {
        const done = await confirmAndRun({
            title: 'Delete this review?',
            message: `"${review.title}" will be permanently deleted. Unlike hiding, it cannot be restored.`,
            confirmLabel: 'Delete it',
            run: () => api.delete(`/reviews/${review.id}`),
        });

        if (done) {
            notify.success('Review deleted.');
            controller.load();
            loadStats();
        }
    }

    await Promise.all([loadStats(), controller.load()]);
}
