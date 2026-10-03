/**
 * public/js/pages/admin/users.js
 *
 * WHAT THIS MODULE DOES
 * User administration: the guest directory plus staff accounts, with create,
 * edit, role change, password reset and removal.
 *
 * WHY IT EXISTS
 * Accounts are created at reception, not by the guest, and roles decide who can
 * check someone in or read the audit log. This is the one screen where that is
 * controlled, so destructive actions are deliberate and confirmed rather than
 * one click away.
 *
 * WHY DELETION IS OFFERED SO RARELY
 * Deleting a user cascades to their bookings, orders and payments, which
 * destroys the financial record. The action is hidden behind a confirmation
 * that names the consequence, and the API refuses it outright when the user is
 * referenced by records.
 *
 * COMMUNICATION
 * Page -> GET    /api/admin/users, /api/admin/roles
 *      -> POST   /api/admin/users
 *      -> PATCH  /api/admin/users/:id
 *      -> POST   /api/admin/users/:id/reset-password
 *      -> DELETE /api/admin/users/:id
 * Database tables used: users, roles
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    openFormModal,
    actionButtons,
    confirmAndRun,
    personCell,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import { createElement, statusBadge, formatDate } from '../../lib/dom.js';

const ROLES = ['admin'];

const shell = await buildShell({
    title: 'Users',
    subtitle: 'Guests and staff accounts',
    roles: ROLES,
});

if (shell?.content) {
    const { user: viewer, content } = shell;

    /** Roles an administrator may assign. */
    let assignableRoles = [];

    async function loadRoles() {
        try {
            const result = await api.get('/admin/roles');
            assignableRoles = (result?.data?.roles || result?.data || []).map((role) => ({
                value: role.name,
                label: role.name.replace('_', ' '),
            }));
        } catch {
            assignableRoles = [];
        }
    }

    addHeaderAction({
        label: 'Add user',
        icon: 'fa-plus',
        onClick: () => createUser(),
    });

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Name or email...' },
                {
                    type: 'select',
                    name: 'role',
                    label: 'Role',
                    options: [{ value: '', label: 'All roles' }],
                },
                {
                    type: 'select',
                    name: 'isActive',
                    label: 'Status',
                    options: [
                        { value: '', label: 'All accounts' },
                        { value: 'true', label: 'Active' },
                        { value: 'false', label: 'Deactivated' },
                    ],
                },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        { header: 'Name', render: (row) => personCell(row.fullName || fullName(row), row.email) },
        { header: 'Phone', render: (row) => createElement('span', { class: 'text-sm', text: row.phone || '-' }) },
        {
            header: 'Role',
            render: (row) =>
                createElement('span', {
                    class: 'text-sm capitalize',
                    text: String(row.role || '').replace('_', ' '),
                }),
        },
        {
            header: 'Status',
            render: (row) =>
                row.isActive
                    ? createElement('span', { class: 'badge badge-success', text: 'Active' })
                    : createElement('span', { class: 'badge badge-neutral', text: 'Deactivated' }),
        },
        {
            header: 'Last seen',
            render: (row) =>
                createElement('span', {
                    class: 'text-sm text-stone-600 whitespace-nowrap',
                    text: row.lastLoginAt ? formatDate(row.lastLoginAt) : 'Never',
                }),
        },
        { header: 'Actions', className: 'text-right', render: (row) => actionsFor(row) },
    ];

    const controller = createListController({
        endpoint: '/admin/users',
        container: listHost,
        state: { search: '', role: '', isActive: '' },
        limit: 20,
        empty: { title: 'No users match', message: 'Try a different search or role.', icon: 'fa-users' },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    /** The API returns `fullName`; the fallback keeps the modal titles readable. */
    function fullName(row) {
        return row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email;
    }

    /**
     * The last active administrator cannot be deactivated or deleted.
     *
     * The API enforces this, and the button is disabled here as well so the
     * user is not invited to try something that will be refused.
     */
    function isLastAdmin(row) {
        return row.role === 'admin' && row.isActive && String(row.id) === String(viewer.id);
    }

    function actionsFor(row) {
        const acts = [
            {
                icon: 'fa-pen',
                label: 'Edit user',
                className: 'btn btn-ghost btn-sm',
                onClick: () => editUser(row),
            },
            {
                icon: 'fa-key',
                label: 'Reset password',
                className: 'btn btn-ghost btn-sm',
                onClick: () => resetPassword(row),
            },
        ];

        if (!isLastAdmin(row)) {
            acts.push({
                icon: row.isActive ? 'fa-user-slash' : 'fa-user-check',
                label: row.isActive ? 'Deactivate account' : 'Reactivate account',
                className: 'btn btn-ghost btn-sm',
                onClick: () => toggleActive(row),
            });
            acts.push({
                icon: 'fa-trash',
                label: 'Delete user',
                className: 'btn btn-ghost btn-sm',
                onClick: () => removeUser(row),
            });
        }

        return actionButtons(acts);
    }

    async function createUser() {
        if (assignableRoles.length === 0) {
            notify.error('Roles could not be loaded, so a new account cannot be created.');
            return;
        }

        const saved = await openFormModal({
            title: 'Add a user',
            submitLabel: 'Create account',
            fields: [
                { name: 'firstName', label: 'First name', required: true },
                { name: 'lastName', label: 'Last name', required: true },
                { name: 'email', label: 'Email', type: 'email', required: true },
                { name: 'phone', label: 'Phone' },
                { name: 'role', label: 'Role', type: 'select', required: true, options: assignableRoles },
                {
                    name: 'password',
                    label: 'Temporary password',
                    type: 'password',
                    required: true,
                    hint: 'At least 8 characters, with a letter and a number.',
                },
            ],
            run: (values) => api.post('/admin/users', values),
        });

        if (saved) {
            notify.success('User created.');
            controller.load();
        }
    }

    async function editUser(row) {
        const saved = await openFormModal({
            title: `Edit ${fullName(row)}`,
            submitLabel: 'Save changes',
            fields: [
                { name: 'firstName', label: 'First name', required: true, value: row.firstName },
                { name: 'lastName', label: 'Last name', required: true, value: row.lastName },
                { name: 'phone', label: 'Phone', value: row.phone || '' },
                { name: 'role', label: 'Role', type: 'select', required: true, value: row.role, options: assignableRoles },
            ],
            run: (values) => api.patch(`/admin/users/${row.id}`, values),
        });

        if (saved) {
            notify.success('User updated.');
            controller.load();
        }
    }

    async function resetPassword(row) {
        const saved = await openFormModal({
            title: `Reset the password for ${fullName(row)}`,
            description: 'The new password must be given to the user directly.',
            submitLabel: 'Reset password',
            fields: [
                {
                    name: 'newPassword',
                    label: 'New password',
                    type: 'password',
                    required: true,
                    hint: 'At least 8 characters, with a letter and a number.',
                },
            ],
            run: (values) => api.post(`/admin/users/${row.id}/reset-password`, values),
        });

        if (saved) {
            notify.success('Password reset.');
        }
    }

    async function toggleActive(row) {
        const next = !row.isActive;
        const done = await confirmAndRun({
            title: next ? 'Reactivate this account?' : 'Deactivate this account?',
            message: next
                ? `${fullName(row)} will be able to sign in again.`
                : `${fullName(row)} will be signed out and unable to sign in. Their bookings and payments are not affected.`,
            confirmLabel: next ? 'Reactivate' : 'Deactivate',
            variant: next ? 'primary' : 'danger',
            run: () => api.patch(`/admin/users/${row.id}`, { isActive: next }),
        });

        if (done) {
            notify.success(next ? 'Account reactivated.' : 'Account deactivated.');
            controller.load();
        }
    }

    async function removeUser(row) {
        const done = await confirmAndRun({
            title: `Delete ${fullName(row)}?`,
            message:
                'This permanently removes the account. It is only possible if they have no bookings, orders or payments recorded against them.',
            confirmLabel: 'Delete user',
            run: () => api.delete(`/admin/users/${row.id}`),
        });

        if (done) {
            notify.success('User deleted.');
            controller.load();
        }
    }

    await loadRoles();

    const roleSelect = content.querySelector('#filter-role');
    if (roleSelect) {
        for (const role of assignableRoles) {
            roleSelect.appendChild(createElement('option', { value: role.value, text: role.label }));
        }
    }

    await controller.load();
}
