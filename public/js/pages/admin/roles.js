/**
 * public/js/pages/admin/roles.js
 *
 * WHAT THIS MODULE DOES
 * Role and permission management: what each role can do, edited as a set of
 * checkboxes.
 *
 * WHY PERMISSIONS ARE EDITED AS A SET
 * The API replaces a role's permissions wholesale rather than accepting
 * individual toggles. Editing one checkbox therefore sends the complete new
 * list, which is why the whole set is gathered before saving and why the
 * dialog says how many are being granted.
 *
 * WHY PROTECTED ROLES ARE MARKED
 * The `guest` role is protected because narrowing it would break the guest
 * pages for everyone at once. It is still editable, but the label makes the
 * risk visible before anyone saves it.
 *
 * COMMUNICATION
 * Page -> GET /api/admin/roles
 *      -> GET /api/admin/permissions
 *      -> PUT /api/admin/roles/:id/permissions
 * Database tables used: roles, permissions, role_permissions, users
 */
import { buildShell } from '../../components/shell.js';
import { openFormModal } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import { createElement, clear, showSkeleton, showEmptyState, formatNumber } from '../../lib/dom.js';

const ROLES = ['admin'];

const shell = await buildShell({
    title: 'Roles & permissions',
    subtitle: 'What each role is allowed to do',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    const grid = createElement('div', { class: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4' });
    content.appendChild(grid);

    async function load() {
        showSkeleton(grid, 6, 'h-56');

        try {
            const [rolesResult, permissionsResult] = await Promise.all([
                api.get('/admin/roles'),
                api.get('/admin/permissions'),
            ]);

            const roles = rolesResult?.data?.roles || [];
            const permissions = permissionsResult?.data?.permissions || [];

            grid.removeAttribute('aria-busy');
            clear(grid);

            if (roles.length === 0) {
                showEmptyState(grid, {
                    title: 'No roles',
                    message: 'Roles are seeded with the system.',
                    icon: 'fa-shield-halved',
                });
                return;
            }

            for (const role of roles) {
                grid.appendChild(roleCard(role, permissions));
            }
        } catch (error) {
            clear(grid);
            showEmptyState(grid, {
                title: 'Could not load roles',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function roleCard(role, permissions) {
        const card = createElement('article', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-4 flex flex-col',
        });

        const head = createElement('div', { class: 'mb-3' });
        const title = createElement('div', { class: 'flex items-center justify-between gap-2' });
        title.append(
            createElement('h2', {
                class: 'font-semibold text-stone-900 capitalize',
                text: String(role.name).replace('_', ' '),
            }),
        );

        if (role.isProtected) {
            title.appendChild(
                createElement('span', { class: 'badge badge-warning', text: 'Protected' }),
            );
        }
        head.appendChild(title);

        if (role.description) {
            head.appendChild(
                createElement('p', { class: 'text-xs text-stone-500 mt-1', text: role.description }),
            );
        }

        head.appendChild(
            createElement('p', {
                class: 'text-xs text-stone-400 mt-2',
                text: `${formatNumber(role.userCount || 0)} user(s) · ${formatNumber(role.permissionCount || 0)} permission(s)`,
            }),
        );

        card.appendChild(head);

        // The granted permissions, listed so the card is readable without
        // opening the editor.
        const list = createElement('ul', { class: 'text-xs text-stone-600 space-y-1 mb-4 flex-1' });
        const granted = new Set(role.permissions || []);

        for (const permission of permissions) {
            if (!granted.has(permission.code)) continue;
            list.appendChild(
                createElement('li', { class: 'flex items-start gap-1.5' }, [
                    createElement('i', { class: 'fa-solid fa-check text-emerald-600 mt-0.5', 'aria-hidden': 'true' }),
                    createElement('span', { text: permission.description || permission.code }),
                ]),
            );
        }

        if (granted.size === 0) {
            list.appendChild(createElement('li', { class: 'text-stone-400', text: 'No permissions granted.' }));
        }

        card.appendChild(list);
        card.appendChild(
            createElement('button', {
                type: 'button',
                class: 'btn btn-outline btn-sm w-full',
                html: '<i class="fa-solid fa-pen" aria-hidden="true"></i> Edit permissions',
                onclick: () => editPermissions(role, permissions),
            }),
        );

        return card;
    }

    async function editPermissions(role, permissions) {
        // Grouped by the resource before the colon, so booking:* permissions
        // sit together rather than being scattered alphabetically.
        const groups = new Map();
        for (const permission of permissions) {
            const [resource] = permission.code.split(':');
            if (!groups.has(resource)) groups.set(resource, []);
            groups.get(resource).push(permission);
        }

        const granted = new Set(role.permissions || []);

        const groupFields = [...groups.entries()].map(([resource, items]) => ({
            name: `group-${resource}`,
            label: resource.charAt(0).toUpperCase() + resource.slice(1),
            type: 'group',
            granted,
            items: items.map((permission) => ({
                value: permission.code,
                label: permission.description || permission.code,
            })),
        }));

        const saved = await openFormModal({
            title: `Permissions for ${String(role.name).replace('_', ' ')}`,
            description: "Saving replaces this role's permissions with exactly what is ticked below.",
            submitLabel: 'Save permissions',
            fields: groupFields,
            run: (values) => {
                // Every group field contributes its ticked codes; the API wants
                // one flat list of permission codes.
                const permissions = groupFields.flatMap((field) => values[field.name] || []);
                return api.put(`/admin/roles/${role.id}/permissions`, { permissions });
            },
        });

        if (saved) {
            notify.success(`Permissions updated for ${role.name}.`);
            load();
        }
    }

    await load();
}
