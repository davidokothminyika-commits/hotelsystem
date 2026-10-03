/**
 * public/js/pages/admin/audit-logs.js
 *
 * WHAT THIS MODULE DOES
 * The audit trail: every recorded action, filterable by action, actor, free text
 * and date range.
 *
 * WHY METADATA IS SHOWN EXPANDABLE
 * An audit row's metadata is machine-shaped JSON and usually meaningless at a
 * glance. It is exactly what an investigator needs, though, so it is one click
 * away rather than either hidden or always in the way.
 *
 * WHY THIS PAGE IS READ ONLY
 * There is no API to create, edit or delete an audit entry, and that is the
 * point. A trail that can be rewritten through the same interface that reads it
 * proves nothing.
 *
 * COMMUNICATION
 * Page -> GET /api/audit-logs
 *      -> GET /api/audit-logs/actions
 * Database tables used: audit_logs, users
 */
import { buildShell } from '../../components/shell.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    personCell,
} from '../../components/admin-ui.js';
import { createElement, formatDate } from '../../lib/dom.js';

const ROLES = ['admin'];

const shell = await buildShell({
    title: 'Audit log',
    subtitle: 'Every recorded action, read only',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Action or email...' },
                { type: 'select', name: 'action', label: 'Action', options: [{ value: '', label: 'All actions' }] },
                { type: 'date', name: 'startDate', label: 'From' },
                { type: 'date', name: 'endDate', label: 'To' },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        {
            header: 'When',
            render: (entry) =>
                createElement('span', {
                    class: 'text-sm text-stone-600 whitespace-nowrap',
                    text: formatDate(entry.createdAt),
                }),
        },
        {
            header: 'Action',
            render: (entry) =>
                createElement('span', {
                    class: 'font-mono text-xs text-stone-700',
                    text: entry.action || '-',
                }),
        },
        {
            header: 'Who',
            render: (entry) =>
                entry.userEmail
                    ? personCell(entry.userName || entry.userEmail, entry.userEmail)
                    : createElement('span', { class: 'text-sm text-stone-400', text: 'System' }),
        },
        {
            header: 'Entity',
            render: (entry) =>
                createElement('span', {
                    class: 'text-sm text-stone-600',
                    text: entry.entity ? `${entry.entity}${entry.entityId ? ` #${entry.entityId}` : ''}` : '-',
                }),
        },
        {
            header: 'IP',
            render: (entry) =>
                createElement('span', { class: 'font-mono text-xs text-stone-500', text: entry.ipAddress || '-' }),
        },
        {
            header: 'Details',
            render: (entry) => (entry.metadata ? metadataToggle(entry) : createElement('span', { class: 'text-xs text-stone-300', text: '—' })),
        },
    ];

    const controller = createListController({
        endpoint: '/audit-logs',
        container: listHost,
        state: { search: '', action: '', startDate: '', endDate: '' },
        limit: 25,
        empty: { title: 'No audit entries match', message: 'Try widening the date range.', icon: 'fa-clipboard-list' },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    /**
     * A disclosure button plus a hidden <pre>.
     *
     * The JSON is inserted as text, never parsed into markup: metadata can
     * contain guest-supplied strings such as a rejected email address, and
     * building HTML from it would reintroduce the injection risk the rest of
     * this frontend avoids.
     */
    function metadataToggle(entry) {
        const pre = createElement('pre', {
            class: 'hidden mt-2 p-2 bg-stone-900 text-stone-100 rounded text-xs overflow-x-auto whitespace-pre-wrap',
            text: JSON.stringify(entry.metadata, null, 2),
        });

        const button = createElement('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            'aria-expanded': 'false',
            html: '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i> View',
            onclick: () => {
                const open = pre.classList.toggle('hidden') === false;
                button.setAttribute('aria-expanded', String(open));
            },
        });

        const wrap = createElement('div');
        wrap.append(button, pre);
        return wrap;
    }

    // The action codes are unknown ahead of time, so the filter is populated
    // from the distinct values the database actually contains.
    async function loadActions() {
        try {
            const result = await api.get('/audit-logs/actions');
            const actions = result?.data?.actions || [];

            const select = content.querySelector('#filter-action');
            if (!select) return;

            for (const action of actions) {
                select.appendChild(createElement('option', { value: action, text: action }));
            }
        } catch {
            // The filter stays as "All actions", which is still usable.
        }
    }

    await loadActions();
    await controller.load();
}
