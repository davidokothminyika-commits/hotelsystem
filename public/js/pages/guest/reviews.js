/**
 * public/js/pages/guest/reviews.js
 *
 * WHAT THIS MODULE DOES
 * Read what other guests said, and leave a review of your own.
 *
 * WHY WRITING IS A SINGLE FORM FOR THE HOTEL
 * One guest can review the hotel once. The form checks for an existing review
 * first and, if there is one, shows it read-only rather than offering an edit
 * the API does not support. Offering a second form that always fails with a
 * duplicate error would be worse than being upfront about the one review limit.
 *
 * WHY THE RATING BREAKDOWN IS SHOWN
 * An average on its own is misleading: 4.5 from ten reviews and 4.5 from a
 * thousand are different claims. Showing the distribution lets a reader judge how
 * much weight the average deserves.
 *
 * COMMUNICATION
 * Page -> GET  /api/reviews?entityType=  (public list, with its stats)
 *      -> GET  /api/reviews/mine?entityType=  (this guest's own review)
 *      -> POST /api/reviews              (writing one)
 * Database tables used: reviews, users
 */
import { buildShell } from '../../components/shell.js';
import { reviewCard } from '../../components/cards.js';
import { statCard } from '../../components/cards.js';
import { openFormModal } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatRating,
    formatNumber,
    formatDate,
} from '../../lib/dom.js';

/** What a guest may review. */
const REVIEWABLE = [
    { value: 'hotel', label: 'The hotel' },
    { value: 'restaurant', label: 'The restaurant' },
    { value: 'service', label: 'The service' },
];

const shell = await buildShell({
    title: 'Reviews',
    subtitle: 'What other guests said',
});

if (shell?.content) {
    const { content } = shell;

    let entityType = 'hotel';
    let myReview = null;

    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    // ---- What to read -----------------------------------------------------
    const scopeBar = createElement('div', { class: 'flex flex-wrap gap-2 mb-4' });
    scopeBar.setAttribute('role', 'group');
    scopeBar.setAttribute('aria-label', 'Choose which reviews to read');

    const SCOPES = [{ value: '', label: 'Everything' }, ...REVIEWABLE];

    for (const scope of SCOPES) {
        scopeBar.appendChild(
            createElement('button', {
                type: 'button',
                class: scope.value === entityType ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
                text: scope.label,
                'aria-pressed': String(scope.value === entityType),
                'data-scope': scope.value,
                onclick: () => {
                    entityType = scope.value;
                    for (const button of scopeBar.querySelectorAll('[data-scope]')) {
                        const active = button.dataset.scope === entityType;
                        button.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
                        button.setAttribute('aria-pressed', String(active));
                    }
                    // All three panels are scoped to the selection, not just the
                    // list. Refetching only the list left the write panel showing
                    // the previous entity's review, so a guest who had already
                    // reviewed the hotel was never offered the form for the
                    // entities they had not reviewed yet.
                    loadStats();
                    loadMyReview();
                    loadReviews();
                },
            }),
        );
    }
    content.appendChild(scopeBar);

    // ---- Write ------------------------------------------------------------
    const writeSlot = createElement('div', { class: 'mb-6' });
    content.appendChild(writeSlot);

    const list = createElement('div', { class: 'space-y-4' });
    content.appendChild(list);

    // =====================================================================
    // Data
    // =====================================================================

    async function loadStats() {
        try {
            const result = await api.get('/reviews/stats', {
                query: entityType ? { entityType } : {},
            });
            const stats = result?.data?.stats || {};

            clear(statsRow);
            statsRow.append(
                statCard({
                    label: 'Average rating',
                    value: formatRating(stats.average),
                    hint: `${formatNumber(stats.total)} review(s)`,
                    icon: 'fa-star',
                    tone: 'warning',
                }),
                statCard({ label: 'Five star', value: formatNumber(stats.distribution?.[5] ?? 0), icon: 'fa-thumbs-up', tone: 'success' }),
                statCard({ label: 'Three star', value: formatNumber(stats.distribution?.[3] ?? 0), icon: 'fa-circle-minus', tone: 'neutral' }),
                statCard({ label: 'One or two star', value: formatNumber((stats.distribution?.[1] ?? 0) + (stats.distribution?.[2] ?? 0)), icon: 'fa-thumbs-down', tone: 'danger' }),
            );
        } catch {
            clear(statsRow);
        }
    }

    async function loadMyReview() {
        try {
            const result = await api.get('/reviews/mine', { query: { entityType } });
            myReview = result?.data?.review || null;
        } catch {
            // A 404 just means there is no review yet, which is the normal case.
            myReview = null;
        }
        renderWritePanel();
    }

    function renderWritePanel() {
        clear(writeSlot);

        if (myReview) {
            const panel = createElement('section', {
                class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-4',
            });
            panel.append(
                createElement('h2', { class: 'font-semibold text-stone-900 mb-1', text: 'Your review' }),
                createElement('p', {
                    class: 'text-sm text-stone-600 mb-2',
                    text: `You rated this ${Number(myReview.rating)} out of 5 on ${formatDate(myReview.createdAt)}.`,
                }),
                createElement('p', { class: 'text-sm text-stone-800 font-medium', text: myReview.title }),
                createElement('p', { class: 'text-sm text-stone-600', text: myReview.comment }),
            );

            if (myReview.staffReply) {
                panel.appendChild(
                    createElement('div', { class: 'mt-3 p-3 bg-amber-50 border-l-2 border-amber-400' }, [
                        createElement('p', { class: 'text-xs font-medium text-amber-900', text: 'Reply from the hotel' }),
                        createElement('p', { class: 'text-sm text-amber-900', text: myReview.staffReply }),
                    ]),
                );
            }

            writeSlot.appendChild(panel);
            return;
        }

        const panel = createElement('section', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3',
        });
        panel.append(
            createElement('div', { class: 'min-w-0' }, [
                createElement('h2', { class: 'font-semibold text-stone-900', text: 'Share your experience' }),
                createElement('p', {
                    class: 'text-sm text-stone-500',
                    text: 'Reviews are published under your name.',
                }),
            ]),
            createElement('button', {
                type: 'button',
                class: 'btn btn-primary',
                html: '<i class="fa-solid fa-star" aria-hidden="true"></i> Write a review',
                onclick: () => writeReview(),
            }),
        );
        writeSlot.appendChild(panel);
    }

    async function writeReview() {
        const saved = await openFormModal({
            title: `Review ${REVIEWABLE.find((r) => r.value === entityType)?.label.toLowerCase() || 'the hotel'}`,
            description: 'Your name will be shown alongside the review.',
            submitLabel: 'Publish review',
            fields: [
                {
                    name: 'entityType',
                    label: 'What are you reviewing?',
                    type: 'select',
                    required: true,
                    value: entityType,
                    options: REVIEWABLE,
                },
                {
                    name: 'rating',
                    label: 'Rating',
                    type: 'select',
                    required: true,
                    value: 5,
                    options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${n} star${n === 1 ? '' : 's'}` })),
                },
                { name: 'title', label: 'Headline', required: true, placeholder: 'Sum up your stay in a few words' },
                { name: 'comment', label: 'Your review', type: 'textarea', rows: 5, required: true },
            ],
            run: (values) => api.post('/reviews', { ...values, entityId: null }),
        });

        if (saved) {
            notify.success('Thank you for your review.');
            loadMyReview();
            loadReviews();
            loadStats();
        }
    }

    async function loadReviews() {
        showSkeleton(list, 3, 'h-32');

        try {
            const result = await api.get('/reviews', {
                query: { limit: 20, entityType: entityType || undefined },
            });

            const reviews = result?.data || [];
            clear(list);

            if (reviews.length === 0) {
                showEmptyState(list, {
                    title: 'No reviews yet',
                    message: 'Be the first to share what it was like.',
                    icon: 'fa-star',
                });
                return;
            }

            for (const review of reviews) {
                list.appendChild(reviewCard(review, { showEntity: true }));
            }
        } catch (error) {
            clear(list);
            showEmptyState(list, {
                title: 'Could not load reviews',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    await Promise.all([loadStats(), loadMyReview(), loadReviews()]);
}
