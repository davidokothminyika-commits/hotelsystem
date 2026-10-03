/**
 * public/js/pages/guest/profile.js
 *
 * WHAT THIS MODULE DOES
 * The guest's own account: their details, their profile image, and the three
 * security-relevant changes (password and email).
 *
 * WHY EMAIL IS SEPARATE FROM THE OTHER DETAILS
 * Changing an email address is a security event, not a profile edit: it is how
 * password resets are routed and it changes who receives booking confirmations.
 * The API requires the current password for it, so it is a separate, confirmed
 * action rather than a field in the details form.
 *
 * WHY THE IMAGE IS UPLOADED SEPARATELY
 * It is a file, so it needs the multipart endpoint rather than the JSON one.
 * That also means a failed image upload cannot roll back the details the guest
 * just saved.
 *
 * COMMUNICATION
 * Page -> GET    /api/users/profile
 *      -> PATCH  /api/users/profile          (details)
 *      -> POST   /api/auth/change-password   (password)
 *      -> POST   /api/users/profile/email    (email, requires the password)
 *      -> POST   /api/users/profile/image    (avatar upload)
 *      -> DELETE /api/users/profile/image    (remove avatar)
 * Database tables used: users, sessions
 */
import { buildShell } from '../../components/shell.js';
import { openFormModal } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatDate,
} from '../../lib/dom.js';

const shell = await buildShell({
    title: 'Profile',
    subtitle: 'Your details and account security',
});

if (shell?.content) {
    const { content } = shell;

    const layout = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start' });
    content.appendChild(layout);

    const identityColumn = createElement('div');
    const detailColumn = createElement('div', { class: 'space-y-6' });
    layout.append(identityColumn, detailColumn);

    let profile = null;

    async function load() {
        showSkeleton(identityColumn, 1, 'h-48');

        try {
            const result = await api.get('/users/profile');
            profile = result?.data?.user;

            if (!profile) {
                clear(identityColumn);
                showEmptyState(identityColumn, {
                    title: 'Could not load your profile',
                    message: 'Please try again.',
                    icon: 'fa-user',
                });
                return;
            }

            renderIdentity();
            renderDetails();
        } catch (error) {
            clear(identityColumn);
            showEmptyState(identityColumn, {
                title: 'Could not load your profile',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    // =====================================================================
    // Identity card
    // =====================================================================
    function renderIdentity() {
        clear(identityColumn);

        const card = createElement('section', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm p-5 text-center',
        });

        const avatar = createElement('span', {
            class: 'inline-flex items-center justify-center w-24 h-24 rounded-full bg-amber-600 text-stone-900 text-2xl font-bold overflow-hidden mb-3',
        });

        if (profile.profileImage) {
            avatar.appendChild(
                createElement('img', {
                    src: profile.profileImage,
                    alt: '',
                    class: 'w-full h-full object-cover',
                }),
            );
        } else {
            const initials = `${profile.firstName?.[0] || ''}${profile.lastName?.[0] || ''}`.toUpperCase();
            avatar.textContent = initials || '?';
        }

        card.append(
            avatar,
            createElement('h2', { class: 'font-bold text-stone-900', text: profile.fullName || 'Guest' }),
            createElement('p', { class: 'text-sm text-stone-500 break-all', text: profile.email }),
        );

        card.appendChild(
            createElement('p', {
                class: `text-xs mt-2 ${profile.emailVerified ? 'text-emerald-600' : 'text-amber-600'}`,
                text: profile.emailVerified ? 'Email verified' : 'Email not yet verified',
            }),
        );

        // Image controls: an upload form because it is multipart, and a remove
        // button that only appears when there is an image to remove.
        const upload = createElement('form', { class: 'mt-4 flex flex-col gap-2' });
        const fileInput = createElement('input', {
            type: 'file',
            accept: 'image/*',
            class: 'hidden',
            id: 'avatar-input',
        });
        fileInput.addEventListener('change', () => uploadAvatar(fileInput.files?.[0]));

        upload.append(
            fileInput,
            createElement('button', {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                html: '<i class="fa-solid fa-camera" aria-hidden="true"></i> Change photo',
                onclick: () => fileInput.click(),
            }),
        );

        if (profile.profileImage) {
            upload.appendChild(
                createElement('button', {
                    type: 'button',
                    class: 'btn btn-ghost btn-sm text-red-600',
                    text: 'Remove photo',
                    onclick: () => removeAvatar(),
                }),
            );
        }

        card.appendChild(upload);
        identityColumn.appendChild(card);
    }

    // =====================================================================
    // Detail panels
    // =====================================================================
    function renderDetails() {
        clear(detailColumn);

        detailColumn.appendChild(
            panel('Your details', 'fa-user', [
                row('Name', `${profile.firstName} ${profile.lastName}`),
                row('Email', profile.email),
                row('Phone', profile.phone || 'Not provided'),
                row('Member since', formatDate(profile.createdAt)),
            ], 'Edit details', () => editDetails()),
        );

        detailColumn.appendChild(
            panel('Password', 'fa-lock', [
                row('Password', 'Set'),
            ], 'Change password', () => changePassword()),
        );

        detailColumn.appendChild(
            panel('Email address', 'fa-envelope', [
                row('Current address', profile.email),
                row(
                    'Verified',
                    profile.emailVerified ? formatDate(profile.emailVerifiedAt) : 'Not verified',
                ),
            ], 'Change email', () => changeEmail()),
        );
    }

    function panel(title, icon, rows, actionLabel, onAction) {
        const section = createElement('section', {
            class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
        });

        section.appendChild(
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3' }, [
                createElement('h2', { class: 'font-semibold text-stone-900 flex items-center gap-2' }, [
                    createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                    createElement('span', { text: title }),
                ]),
                createElement('button', { type: 'button', class: 'btn btn-outline btn-sm', text: actionLabel, onclick: onAction }),
            ]),
        );

        const body = createElement('div', { class: 'px-4 py-2' });
        for (const entry of rows) body.appendChild(entry);
        section.appendChild(body);

        return section;
    }

    function row(label, value) {
        const element = createElement('div', {
            class: 'flex items-center justify-between gap-3 py-2 border-b border-stone-100 last:border-0',
        });
        element.append(
            createElement('span', { class: 'text-sm text-stone-500 shrink-0', text: label }),
            createElement('span', { class: 'text-sm text-stone-900 text-right break-all', text: value }),
        );
        return element;
    }

    // =====================================================================
    // Actions
    // =====================================================================
    async function editDetails() {
        const saved = await openFormModal({
            title: 'Edit your details',
            submitLabel: 'Save changes',
            fields: [
                { name: 'firstName', label: 'First name', required: true, value: profile.firstName },
                { name: 'lastName', label: 'Last name', required: true, value: profile.lastName },
                { name: 'phone', label: 'Phone', value: profile.phone || '' },
            ],
            run: (values) => api.patch('/users/profile', values),
        });

        if (saved) {
            notify.success('Details updated.');
            load();
        }
    }

    async function changePassword() {
        const saved = await openFormModal({
            title: 'Change your password',
            submitLabel: 'Change password',
            fields: [
                { name: 'currentPassword', label: 'Current password', type: 'password', required: true },
                { name: 'newPassword', label: 'New password', type: 'password', required: true, hint: 'At least 8 characters.' },
                { name: 'confirmPassword', label: 'Confirm new password', type: 'password', required: true },
            ],
            run: (values) => api.post('/auth/change-password', values),
        });

        if (saved) {
            notify.success('Password changed.');
        }
    }

    async function changeEmail() {
        const saved = await openFormModal({
            title: 'Change your email address',
            description:
                'Booking confirmations and password resets will go to the new address. Confirm your password to continue.',
            submitLabel: 'Change email',
            fields: [
                { name: 'email', label: 'New email address', type: 'email', required: true },
                { name: 'password', label: 'Your current password', type: 'password', required: true },
            ],
            run: (values) => api.post('/users/profile/email', values),
        });

        if (saved) {
            notify.success('Email address updated. Check it to confirm the change.');
            load();
        }
    }

    async function uploadAvatar(file) {
        if (!file) return;

        // The endpoint is multipart, so this cannot go through api.js, which
        // only speaks JSON.
        const form = new FormData();
        form.append('image', file);

        try {
            const response = await fetch('/api/users/profile/image', {
                method: 'POST',
                credentials: 'include',
                body: form,
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.message || 'Could not upload that image.');
            }

            notify.success('Photo updated.');
            load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function removeAvatar() {
        try {
            await api.delete('/users/profile/image');
            notify.success('Photo removed.');
            load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    await load();
}
