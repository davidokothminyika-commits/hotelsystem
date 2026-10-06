/**
 * public/js/pages/admin/settings.js
 *
 * WHAT THIS MODULE DOES
 * Two things on one screen:
 *
 *   1. An editable panel for the hotel's branding: its name, the tagline under
 *      the wordmark, the logo and the public contact details. This is the part
 *      of the configuration an administrator is expected to change.
 *   2. Read-only panels reporting the runtime configuration and reference data
 *      that comes from environment variables.
 *
 * WHY THE REST OF THIS PAGE IS READ ONLY
 * Everything below the branding panel comes from environment variables and from
 * reference tables, and changing either from a browser screen would mean
 * shipping secrets to the client and letting an unaudited request rewrite the
 * settings every request depends on. Those panels therefore report what is
 * actually in force, which is the thing an administrator genuinely needs when
 * diagnosing a deployment: is the payment provider the mock, which currency is
 * live, is mail enabled.
 *
 * WHY NO SECRET IS EVER DISPLAYED
 * The configuration endpoints return only non-sensitive values. Nothing here
 * reads a token, a password or a connection string.
 *
 * WHY THE LOGO IS OFFERED TWO WAYS
 * Uploading suits a hotel that has a file; a URL suits one whose logo already
 * lives on a CDN. The server keeps only one of the two at a time, so this form
 * sends the URL only when the administrator has edited it or asked to remove the
 * logo. Otherwise saving an unrelated field would silently delete the uploaded
 * file, which is the kind of surprise that makes people stop trusting a form.
 *
 * COMMUNICATION
 * Page -> GET /api/settings/branding   (read the current branding)
 *      -> PUT /api/settings/branding   (save name, tagline, contact details)
 *      -> POST /api/settings/logo      (multipart logo upload)
 *      -> GET /api/payments/config     (provider, currency, methods, test cards)
 *      -> GET /api/menu/categories     (menu reference data)
 *      -> GET /api/rooms/types         (room type reference data)
 *      -> GET /api/admin/roles         (roles in use)
 * Database tables used: system_settings, through the settings API.
 */
import { buildShell } from '../../components/shell.js';
import api from '../../api/api.js';
import { createElement, clear, showSkeleton, formatMoney, setButtonLoading } from '../../lib/dom.js';
import { buildField } from '../../components/admin-ui.js';
import { setBranding } from '../../components/branding.js';
import notify, { showAlert, showFieldErrors } from '../../components/notification.js';

const ROLES = ['admin'];

const shell = await buildShell({
    title: 'Settings',
    subtitle: 'Branding and runtime configuration',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    function panel(title, icon, body) {
        return createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: title }),
            ]),
            body,
        ]);
    }

    // ---------------------------------------------------------------------
    // Brand and contact details
    // ---------------------------------------------------------------------

    /**
     * Builds the editable panel and returns it.
     *
     * A plain form rather than the modal helper the other admin screens use:
     * this is a long-lived form with a logo preview and two ways to set the
     * logo, which does not fit the shape of a modal dialog.
     */
    function brandingPanel() {
        const form = createElement('form', { id: 'branding-form', class: 'p-4 space-y-4' });

        const alertBox = createElement('div', {
            class: 'hidden rounded-lg border px-4 py-3 text-sm',
            role: 'alert',
        });

        // ---- Logo preview ----
        const previewBadge = createElement('span', {
            class: 'flex items-center justify-center w-16 h-16 rounded-xl bg-amber-600 text-stone-900 overflow-hidden shrink-0',
            'aria-hidden': 'true',
        });

        const logoSource = createElement('p', {
            id: 'logo-source',
            class: 'text-xs text-stone-500',
            text: 'Using the built-in hotel icon',
        });

        const preview = createElement('div', { class: 'flex items-center gap-4' }, [
            previewBadge,
            createElement('div', { class: 'min-w-0' }, [
                createElement('p', { class: 'text-sm font-medium text-stone-900', text: 'Logo' }),
                logoSource,
            ]),
        ]);

        // A hidden file input driven by a styled button, so the control matches
        // the buttons used everywhere else on the site.
        const fileInput = createElement('input', {
            type: 'file',
            id: 'logo-file',
            class: 'hidden',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
        });

        const uploadButton = createElement('button', {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: () => fileInput.click(),
        }, [createElement('i', { class: 'fa-solid fa-upload', 'aria-hidden': 'true' }), ' Upload an image']);

        const removeButton = createElement('button', {
            type: 'button',
            class: 'btn btn-outline btn-sm',
            onclick: () => {
                // Deferred to the save so a mis-click is still cancellable:
                // closing the message below abandons the removal.
                removeRequested = true;
                fields.logoUrl.querySelector('input').value = '';
                showAlert(alertBox, 'The logo will be removed when you save.', 'info');
            },
        }, [createElement('i', { class: 'fa-solid fa-trash-can', 'aria-hidden': 'true' }), ' Remove logo']);

        const logoButtons = createElement('div', { class: 'flex flex-wrap items-center gap-2' }, [
            uploadButton,
            removeButton,
        ]);

        // ---- Text fields ----
        const fields = {
            systemName: buildField({
                name: 'systemName',
                label: 'System name',
                type: 'text',
                maxlength: 120,
                hint: 'Shown in the header, the page titles and the sign in page.',
            }),
            tagline: buildField({
                name: 'tagline',
                label: 'Tagline',
                type: 'text',
                maxlength: 150,
                placeholder: 'Nairobi, Kenya',
                hint: 'The small line under the name. Leave empty to hide it.',
            }),
            logoUrl: buildField({
                name: 'logoUrl',
                label: 'Or use an image URL',
                type: 'url',
                placeholder: 'https://example.com/logo.png',
                hint: 'Must be a full http:// or https:// address. Leave unchanged to keep the current logo.',
            }),
            contactPhone: buildField({ name: 'contactPhone', label: 'Phone', type: 'tel' }),
            contactEmail: buildField({ name: 'contactEmail', label: 'Email', type: 'email' }),
            contactAddress: buildField({ name: 'contactAddress', label: 'Address', type: 'text', maxlength: 255 }),
        };

        const saveButton = createElement('button', { type: 'submit', class: 'btn btn-primary' }, ['Save changes']);

        form.append(
            alertBox,
            preview,
            fileInput,
            logoButtons,
            fields.systemName,
            fields.tagline,
            fields.logoUrl,
            fields.contactPhone,
            fields.contactEmail,
            fields.contactAddress,
            createElement('div', { class: 'flex items-center gap-3 pt-1' }, [saveButton]),
        );

        // The URL the logo currently comes from. Only a change to this field
        // reaches the server, so saving the name never deletes an upload.
        let logoUrlBaseline = '';
        let removeRequested = false;

        /** Fills the form and the preview from a branding object. */
        function render(branding) {
            fields.systemName.querySelector('input').value = branding.systemName || '';
            fields.tagline.querySelector('input').value = branding.tagline || '';
            fields.contactPhone.querySelector('input').value = branding.contactPhone || '';
            fields.contactEmail.querySelector('input').value = branding.contactEmail || '';
            fields.contactAddress.querySelector('input').value = branding.contactAddress || '';

            // An uploaded file has no URL the administrator typed, so the field
            // starts empty and the source line explains where the logo is from.
            const typedUrl = branding.logoUrl && !branding.logoPath ? branding.logoUrl : '';
            logoUrlBaseline = typedUrl;
            removeRequested = false;
            fields.logoUrl.querySelector('input').value = typedUrl;

            clear(previewBadge);
            if (branding.logoUrl) {
                previewBadge.appendChild(
                    createElement('img', {
                        src: branding.logoUrl,
                        alt: '',
                        class: 'w-full h-full object-contain bg-white p-1',
                    }),
                );
            } else {
                previewBadge.appendChild(createElement('i', { class: 'fa-solid fa-hotel', 'aria-hidden': 'true' }));
            }

            logoSource.textContent = branding.logoPath
                ? 'Using the uploaded image'
                : branding.logoUrl
                  ? 'Using the image URL'
                  : 'Using the built-in hotel icon';

            removeButton.classList.toggle('hidden', !branding.logoUrl);
        }

        /** Uploads a file and repaints from the response. */
        async function uploadLogo(file) {
            setButtonLoading(uploadButton, true, 'Uploading...');
            alertBox.classList.add('hidden');

            const data = new FormData();
            data.append('image', file);

            try {
                // The endpoint is multipart, so it cannot go through api.js,
                // which only speaks JSON. Same pattern as the profile photo.
                const response = await fetch('/api/settings/logo', {
                    method: 'POST',
                    credentials: 'include',
                    body: data,
                });

                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(payload?.message || 'Could not upload that image.');
                }

                // Repaints this page's header, sidebar and footer too.
                setBranding(payload.data.branding);
                render(payload.data.branding);
                notify.success('Logo updated');
            } catch (error) {
                showAlert(alertBox, error.message, 'error');
            } finally {
                setButtonLoading(uploadButton, false);
            }
        }

        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            // Cleared so choosing the same file again still fires a change event.
            fileInput.value = '';
            if (file) uploadLogo(file);
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            alertBox.classList.add('hidden');
            setButtonLoading(saveButton, true, 'Saving...');

            const editedUrl = fields.logoUrl.querySelector('input').value.trim();

            const payload = {
                systemName: fields.systemName.querySelector('input').value.trim(),
                tagline: fields.tagline.querySelector('input').value.trim(),
                contactPhone: fields.contactPhone.querySelector('input').value.trim(),
                contactEmail: fields.contactEmail.querySelector('input').value.trim(),
                contactAddress: fields.contactAddress.querySelector('input').value.trim(),
            };

            // Left out entirely unless the logo was actually touched, so the
            // server keeps whichever logo is live.
            if (removeRequested || editedUrl !== logoUrlBaseline) {
                payload.logoUrl = removeRequested ? '' : editedUrl;
            }

            try {
                const result = await api.put('/settings/branding', payload);

                setBranding(result.data.branding);
                render(result.data.branding);
                setButtonLoading(saveButton, false);
                notify.success('Settings saved');
            } catch (error) {
                setButtonLoading(saveButton, false);
                // Mark the offending fields as well as saying why, so a name
                // that is too short is fixed in place rather than guessed at.
                if (error.errors) showFieldErrors(form, error.errors);
                showAlert(alertBox, firstErrorMessage(error), 'error');
            }
        });

        // Same panel shell as the read-only panels below, but built here rather
        // than through the helper because the body is a live form.
        const element = createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: 'fa-solid fa-hotel text-amber-600', 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: 'Brand and contact' }),
                createElement('span', { class: 'text-xs text-stone-500 ml-auto', text: 'Shown site-wide' }),
            ]),
            form,
        ]);

        return { element, render, alertBox };
    }

    /**
     * Surfaces the first field error the API reported, in one line.
     * The validator returns them keyed by field name, e.g. { systemName: '...' }.
     */
    function firstErrorMessage(error) {
        const errors = error.errors;
        if (errors && typeof errors === 'object') {
            const first = Object.values(errors)[0];
            if (first) return String(first);
        }
        return error.message || 'Could not save the settings.';
    }

    // Built first so the loader below can reach its render function.
    const brandingForm = brandingPanel();

    content.appendChild(brandingForm.element);

    content.appendChild(
        createElement('h2', {
            class: 'text-sm font-semibold text-stone-500 uppercase tracking-wide',
            text: 'Runtime configuration',
        }),
    );

    const layout = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' });
    content.appendChild(layout);
    const paymentsBody = createElement('div', { class: 'p-4' });
    const roomTypesBody = createElement('div', { class: 'p-4' });
    const menuBody = createElement('div', { class: 'p-4' });
    const rolesBody = createElement('div', { class: 'p-4' });

    layout.append(
        panel('Payments', 'fa-credit-card', paymentsBody),
        panel('Room types', 'fa-bed', roomTypesBody),
        panel('Menu categories', 'fa-utensils', menuBody),
        panel('Roles in use', 'fa-shield-halved', rolesBody),
    );

    async function load() {
        for (const body of [paymentsBody, roomTypesBody, menuBody, rolesBody]) {
            showSkeleton(body, 3, 'h-8');
        }

        const [payments, roomTypes, categories, roles] = await Promise.all([
            api.get('/payments/config').catch(() => null),
            api.get('/rooms/types').catch(() => null),
            api.get('/menu/categories').catch(() => null),
            api.get('/admin/roles').catch(() => null),
        ]);

        renderPayments(payments?.data);
        renderRoomTypes(roomTypes?.data);
        renderCategories(categories?.data);
        renderRoles(roles?.data);
    }

    /** A label/value list, the repeated shape of every panel here. */
    function rows(container, entries) {
        clear(container);
        for (const [label, value] of entries) {
            const row = createElement('div', {
                class: 'flex items-center justify-between gap-3 py-1.5 border-b border-stone-100 last:border-0',
            });
            row.append(
                createElement('span', { class: 'text-sm text-stone-600 shrink-0', text: label }),
                createElement('span', { class: 'text-sm font-medium text-stone-900 text-right', text: value }),
            );
            container.appendChild(row);
        }
    }

    function renderPayments(config) {
        if (!config) {
            rows(paymentsBody, [['Status', 'Unavailable']]);
            return;
        }

        rows(paymentsBody, [
            ['Provider', config.providerName || config.provider],
            ['Provider id', config.provider],
            ['Currency', config.currency],
            ['Accepted methods', (config.methods || []).join(', ')],
            ['Mode', config.simulated ? 'Simulated (no real money moves)' : 'Live'],
            ['Registered providers', (config.providers || []).map((p) => p.name).join(', ')],
        ]);

        // The test cards are only meaningful when the gateway is simulated, so
        // they are listed conditionally rather than implying they apply.
        if (config.simulated && (config.testCards || []).length) {
            paymentsBody.appendChild(
                createElement('p', {
                    class: 'text-xs text-stone-500 mt-3 mb-1 font-medium',
                    text: 'Test cards',
                }),
            );
            for (const card of config.testCards) {
                const row = createElement('div', { class: 'flex items-center justify-between gap-3 py-1' });
                row.append(
                    createElement('span', { class: 'font-mono text-xs text-stone-700', text: card.number }),
                    createElement('span', { class: 'text-xs text-stone-500', text: card.label }),
                );
                paymentsBody.appendChild(row);
            }
        }
    }

    function renderRoomTypes(data) {
        const types = data?.roomTypes || data || [];
        if (!Array.isArray(types) || types.length === 0) {
            rows(roomTypesBody, [['Status', 'None configured']]);
            return;
        }

        clear(roomTypesBody);
        for (const type of types) {
            const row = createElement('div', {
                class: 'flex items-center justify-between gap-3 py-2 border-b border-stone-100 last:border-0',
            });
            const left = createElement('div', { class: 'min-w-0' });
            left.append(
                createElement('p', { class: 'text-sm font-medium text-stone-900', text: type.name }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: `${type.bedConfiguration || ''} · ${type.sizeSqm || '?'} m²`,
                }),
            );
            row.append(
                left,
                createElement('span', { class: 'text-sm text-stone-700', text: formatMoney(type.basePrice ?? type.price) }),
            );
            roomTypesBody.appendChild(row);
        }
    }

    function renderCategories(data) {
        const categories = data?.categories || [];
        rows(
            menuBody,
            categories.length
                ? categories.map((category) => [category.name, `${category.itemCount ?? 0} item(s)`])
                : [['Status', 'None configured']],
        );
    }

    function renderRoles(data) {
        const list = data?.roles || [];
        rows(
            rolesBody,
            list.length
                ? list.map((role) => [
                      role.name.replace('_', ' '),
                      `${role.userCount ?? 0} user(s), ${role.permissionCount ?? 0} permission(s)`,
                  ])
                : [['Status', 'Unavailable']],
        );
    }

    /**
     * Fills the branding form with the stored values.
     *
     * On failure the form is left empty with an explanation, rather than
     * showing blanks that would look like the hotel's real settings.
     */
    async function loadBranding() {
        try {
            const result = await api.get('/settings/branding');
            // The page may have loaded with the defaults; the stored values win.
            setBranding(result.data.branding);
            brandingForm.render(result.data.branding);
        } catch (error) {
            showAlert(brandingForm.alertBox, `Could not load the current settings: ${error.message}`, 'error');
        }
    }

    // Both halves load independently: the branding form is what an
    // administrator edits, so a failure in the read-only lookups below
    // must not stop it from appearing.
    await Promise.all([loadBranding(), load()]);
}
