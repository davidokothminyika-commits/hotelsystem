/**
 * public/js/pages/staff/housekeeping.js
 *
 * WHAT THIS MODULE DOES
 * A room status board for housekeeping: every room, its current state, and the
 * one transition that moves the cleaning queue along.
 *
 * WHY IT EXISTS
 * Housekeeping works a queue, not a spreadsheet. The useful view is every room
 * grouped by what still needs doing to it, with the next action one click away,
 * which is why this is a status board rather than a table with an edit button.
 *
 * WHY STATUS CHANGES ARE CONFIRMED AND AUDITED
 * Marking a room clean is what lets the front desk sell it again, so a mistaken
 * click has a real cost. The API records who changed the state and when.
 *
 * COMMUNICATION
 * Page -> GET /api/rooms?limit=100&status=...   (the board)
 *      -> GET /api/rooms/status-counts          (the counters)
 *      -> PATCH /api/rooms/:id/status           (the transition)
 * Database tables used: rooms, room_types, bookings
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { statCard } from '../../components/cards.js';
import { confirmAndRun } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showEmptyState,
    showSkeleton,
    statusBadge,
} from '../../lib/dom.js';

const STAFF_ROLES = ['housekeeping', 'receptionist', 'manager', 'admin'];

/**
 * The statuses a room can be moved to, and what the button should say.
 *
 * The labels describe the action, not the destination, because "Mark clean" is
 * unambiguous on a board where the room is visibly dirty, while "Set status:
 * available" is not.
 */
const TRANSITIONS = {
    occupied: [{ to: 'cleaning', label: 'Start cleaning', icon: 'fa-broom', variant: 'btn-primary' }],
    cleaning: [
        { to: 'available', label: 'Mark clean', icon: 'fa-check', variant: 'btn-primary' },
        { to: 'maintenance', label: 'Flag maintenance', icon: 'fa-wrench', variant: 'btn-outline' },
    ],
    maintenance: [
        { to: 'cleaning', label: 'Send to cleaning', icon: 'fa-broom', variant: 'btn-outline' },
        { to: 'available', label: 'Return to service', icon: 'fa-check', variant: 'btn-primary' },
    ],
    available: [{ to: 'cleaning', label: 'Needs cleaning', icon: 'fa-broom', variant: 'btn-outline' }],
    reserved: [{ to: 'occupied', label: 'Mark occupied', icon: 'fa-door-open', variant: 'btn-outline' }],
};

const shell = await buildShell({
    title: 'Room status',
    subtitle: 'What needs cleaning, and what is out of service',
    roles: STAFF_ROLES,
});

if (shell?.content) {
    const { content } = shell;

    let currentFilter = '';
    let rooms = [];

    addHeaderAction({
        label: 'Refresh',
        icon: 'fa-rotate',
        variant: 'outline',
        href: '#',
        onClick: (event) => {
            event.preventDefault();
            load();
        },
    });

    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6' });
    content.appendChild(statsRow);

    // Status filter chips.
    const filters = [
        { value: '', label: 'All rooms' },
        { value: 'available', label: 'Available' },
        { value: 'occupied', label: 'Occupied' },
        { value: 'cleaning', label: 'Cleaning' },
        { value: 'maintenance', label: 'Maintenance' },
        { value: 'reserved', label: 'Reserved' },
    ];

    const filterBar = createElement('div', { class: 'flex flex-wrap gap-2 mb-6' });
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter rooms by status');

    for (const filter of filters) {
        filterBar.appendChild(
            createElement('button', {
                type: 'button',
                class: filter.value === currentFilter ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
                text: filter.label,
                'aria-pressed': String(filter.value === currentFilter),
                'data-filter': filter.value,
                onclick: () => {
                    currentFilter = filter.value;
                    for (const button of filterBar.querySelectorAll('[data-filter]')) {
                        const active = button.dataset.filter === currentFilter;
                        // Complete class literals only: the Tailwind CDN cannot
                        // see a class name built at runtime.
                        button.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
                        button.setAttribute('aria-pressed', String(active));
                    }
                    load();
                },
            }),
        );
    }
    content.appendChild(filterBar);

    const board = createElement('div', { class: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4' });
    content.appendChild(board);

    // =====================================================================
    // Data
    // =====================================================================

    async function loadCounts() {
        let counts = {};
        try {
            const result = await api.get('/rooms/status-counts');
            counts = result?.data?.counts || {};
        } catch {
            // Counters are decoration; the board is the working surface.
        }

        clear(statsRow);
        statsRow.append(
            statCard({ label: 'Available', value: counts.available ?? 0, icon: 'fa-door-open', tone: 'success' }),
            statCard({ label: 'Occupied', value: counts.occupied ?? 0, icon: 'fa-user', tone: 'info' }),
            statCard({ label: 'Reserved', value: counts.reserved ?? 0, icon: 'fa-bookmark', tone: 'warning' }),
            statCard({ label: 'Cleaning', value: counts.cleaning ?? 0, icon: 'fa-broom', tone: 'accent' }),
            statCard({ label: 'Maintenance', value: counts.maintenance ?? 0, icon: 'fa-wrench', tone: 'danger' }),
        );
    }

    async function load() {
        showSkeleton(board, 6, 'h-32');

        try {
            const result = await api.get('/rooms', {
                query: {
                    limit: 100,
                    status: currentFilter || undefined,
                },
            });

            rooms = result?.data || [];
            board.removeAttribute('aria-busy');
            clear(board);

            if (rooms.length === 0) {
                showEmptyState(board, {
                    title: 'No rooms here',
                    message: currentFilter
                        ? 'No rooms currently have that status.'
                        : 'No rooms have been added yet.',
                    icon: 'fa-bed',
                });
                return;
            }

            for (const room of rooms) {
                board.appendChild(roomCard(room));
            }
        } catch (error) {
            clear(board);
            showEmptyState(board, {
                title: 'Could not load rooms',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function roomCard(room) {
        const card = createElement('article', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-4 flex flex-col',
        });

        const top = createElement('div', { class: 'flex items-start justify-between gap-2 mb-2' });
        const title = createElement('div');
        title.append(
            createElement('p', { class: 'font-semibold text-stone-900', text: `Room ${room.roomNumber}` }),
            createElement('p', {
                class: 'text-xs text-stone-500',
                text: `${room.roomType?.name || 'Untyped'} · Floor ${room.floor ?? '-'}`,
            }),
        );
        top.append(title, statusBadge(room.status));

        const meta = createElement('div', { class: 'text-xs text-stone-500 flex flex-wrap gap-x-3 gap-y-1 mb-3' });
        meta.append(
            createElement('span', { text: `Sleeps ${room.capacity ?? '-'}` }),
            createElement('span', { text: room.roomType?.bedConfiguration || '' }),
        );

        card.append(top, meta);

        const actions = TRANSITIONS[room.status] || [];
        if (actions.length) {
            const footer = createElement('div', { class: 'flex flex-wrap gap-2 mt-auto' });
            for (const action of actions) {
                footer.appendChild(
                    createElement('button', {
                        type: 'button',
                        class: `${action.variant} btn-sm flex-1`,
                        html: `<i class="fa-solid ${action.icon}" aria-hidden="true"></i> ${action.label}`,
                        onclick: () => changeStatus(room, action),
                    }),
                );
            }
            card.appendChild(footer);
        } else {
            card.appendChild(
                createElement('p', { class: 'text-xs text-stone-400 mt-auto', text: 'No action available' }),
            );
        }

        return card;
    }

    async function changeStatus(room, action) {
        const done = await confirmAndRun({
            title: action.label,
            message:
                action.to === 'available'
                    ? `Room ${room.roomNumber} will be marked clean and can be sold to a guest.`
                    : `Room ${room.roomNumber} will be set to "${action.to.replace('_', ' ')}".`,
            confirmLabel: action.label,
            variant: action.to === 'maintenance' ? 'danger' : 'primary',
            run: () => api.patch(`/rooms/${room.id}/status`, { status: action.to }),
        });

        if (done) {
            notify.success(`Room ${room.roomNumber} is now ${action.to.replace('_', ' ')}.`);
            await load();
            await loadCounts();
        }
    }

    await loadCounts();
    await load();
}
