/**
 * public/js/pages/auth/reset-password.js
 *
 * WHAT THIS MODULE DOES
 * Completes a password reset: checks the token from the emailed link, then
 * lets the visitor choose a new password.
 *
 * WHY THE TOKEN IS CHECKED BEFORE THE FORM APPEARS
 * A reset link is followed from an email, so it is often stale: already used,
 * expired, or mistyped. Showing a password form first and failing on submit
 * makes the visitor type two passwords before telling them the link is dead.
 * The token is validated on load and the page explains what happened instead.
 *
 * WHY THERE IS NO buildShell HERE
 * The visitor cannot sign in yet, which is why they are on this page. Requiring
 * a session would redirect them away from the form that fixes it.
 *
 * COMMUNICATION
 * Page -> POST /api/auth/verify-reset-token { token }  (is the link still good)
 *      -> POST /api/auth/reset-password   { token, password, confirmPassword }
 * Database tables used: password_resets, users, audit_logs
 */
import { initApp } from '../../app.js';
import authApi from '../../api/auth.js';
import { showAlert, clearFieldErrors, notify } from '../../components/notification.js';
import { getQueryParam, setButtonLoading } from '../../lib/dom.js';

await initApp({ footer: true, sidebar: false });

const main = document.createElement('main');
main.id = 'main-content';
main.className = 'flex items-center justify-center px-4 py-16';
document.body.appendChild(main);

/** Renders one of the terminal states: invalid link, or a completed reset. */
function renderMessage({ icon, tone, title, body, actions = [] }) {
    const card = document.createElement('div');
    card.className = 'w-full max-w-md bg-white rounded-xl border border-stone-200 shadow-sm p-6 sm:p-8 text-center';

    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon} text-4xl mb-4 ${tone}`;
    glyph.setAttribute('aria-hidden', 'true');

    const heading = document.createElement('h1');
    heading.className = 'text-xl font-bold text-stone-900 mb-2';
    heading.textContent = title;

    const paragraph = document.createElement('p');
    paragraph.className = 'text-sm text-stone-500';
    paragraph.textContent = body;

    card.append(glyph, heading, paragraph);

    if (actions.length) {
        const row = document.createElement('div');
        row.className = 'mt-6 flex flex-col sm:flex-row gap-2 justify-center';
        for (const action of actions) {
            row.appendChild(
                document.createElement('a', {
                    href: action.href,
                    class: `btn ${action.variant || 'btn-primary'} btn-block sm:w-auto`,
                    text: action.label,
                }),
            );
        }
        card.appendChild(row);
    }

    main.replaceChildren(card);
}

/** Shows the brand and heading, used by the states that need a title block. */
function brand() {
    const link = document.createElement('a');
    link.href = '/';
    link.className = 'inline-flex items-center gap-2.5 mb-8';
    link.innerHTML = `
        <span class="flex items-center justify-center w-10 h-10 rounded-lg bg-amber-600 text-stone-900">
            <i class="fa-solid fa-hotel" aria-hidden="true"></i>
        </span>
        <span>
            <span class="block text-base font-semibold text-stone-900 leading-tight">Aurelia Grand Hotel</span>
            <span class="block text-xs text-stone-500">Nairobi, Kenya</span>
        </span>`;
    return link;
}

const token = getQueryParam('token');

// =====================================================================
// No token at all: the visitor typed or truncated the URL.
// =====================================================================
if (!token) {
    renderMessage({
        icon: 'fa-link-slash',
        tone: 'text-stone-400',
        title: 'This link is incomplete',
        body: 'The reset link is missing its security token. Request a new one and use the link straight from your email.',
        actions: [
            { label: 'Request a new link', href: '/pages/auth/forgot-password.html' },
            { label: 'Back to sign in', href: '/pages/auth/login.html', variant: 'btn-outline' },
        ],
    });
} else {
    // =====================================================================
    // Checking the token
    // =====================================================================
    const loading = document.createElement('div');
    loading.className = 'text-center text-stone-500 flex flex-col items-center gap-3';
    loading.innerHTML = `
        <i class="fa-solid fa-spinner fa-spin text-2xl" aria-hidden="true"></i>
        <p class="text-sm">Checking your reset link...</p>`;
    main.replaceChildren(loading);

    let tokenIsValid = false;

    try {
        const result = await authApi.verifyResetToken(token);
        tokenIsValid = Boolean(result?.data?.valid);
    } catch {
        // Treated the same as an invalid link: the page must not reveal whether
        // the token exists, only that it cannot be used.
        tokenIsValid = false;
    }

    if (!tokenIsValid) {
        renderMessage({
            icon: 'fa-clock-rotate-left',
            tone: 'text-amber-600',
            title: 'This link has expired',
            body: 'Reset links can only be used once and last an hour. Request a fresh one and it will arrive in a moment.',
            actions: [
                { label: 'Request a new link', href: '/pages/auth/forgot-password.html' },
                { label: 'Back to sign in', href: '/pages/auth/login.html', variant: 'btn-outline' },
            ],
        });
    } else {
        // =====================================================================
        // The form
        // =====================================================================
        const card = document.createElement('div');
        card.className = 'w-full max-w-md bg-white rounded-xl border border-stone-200 shadow-sm p-6 sm:p-8';

        const heading = document.createElement('h1');
        heading.className = 'text-2xl font-bold text-stone-900 mb-1';
        heading.textContent = 'Choose a new password';

        const subheading = document.createElement('p');
        subheading.className = 'text-sm text-stone-500 mb-8';
        subheading.textContent = 'Pick something you have not used here before.';

        const alertBox = document.createElement('div');
        alertBox.className = 'hidden rounded-lg border px-4 py-3 text-sm mb-5';
        alertBox.setAttribute('role', 'alert');

        const form = document.createElement('form');
        form.id = 'reset-password-form';
        form.noValidate = true;

        function field({ id, name, label, autocomplete, placeholder }) {
            const wrap = document.createElement('div');
            wrap.className = 'field';

            const fieldLabel = document.createElement('label');
            fieldLabel.className = 'form-label';
            fieldLabel.setAttribute('for', id);
            fieldLabel.textContent = label;

            const input = document.createElement('input');
            input.type = 'password';
            input.id = id;
            input.name = name;
            input.className = 'form-input';
            input.autocomplete = autocomplete;
            input.required = true;
            input.placeholder = placeholder;

            const error = document.createElement('p');
            error.className = 'form-error';
            error.id = `${id}-error`;

            wrap.append(fieldLabel, input, error);
            form.appendChild(wrap);

            return input;
        }

        const passwordInput = field({
            id: 'password',
            name: 'password',
            label: 'New password',
            autocomplete: 'new-password',
            placeholder: 'At least 8 characters',
        });

        const confirmInput = field({
            id: 'confirmPassword',
            name: 'confirmPassword',
            label: 'Confirm new password',
            autocomplete: 'new-password',
            placeholder: 'Type it again',
        });

        // Toggling is a security question: on a shared machine the new password
        // should not be visible by default, so it starts hidden every time.
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'toggle-password';
        toggle.className = 'absolute inset-y-0 right-0 px-3 text-stone-400 hover:text-stone-700';
        toggle.setAttribute('aria-label', 'Show password');
        toggle.innerHTML = '<i class="fa-solid fa-eye" aria-hidden="true"></i>';

        toggle.addEventListener('click', () => {
            const hidden = passwordInput.type === 'password';
            passwordInput.type = hidden ? 'text' : 'password';
            confirmInput.type = hidden ? 'text' : 'password';
            toggle.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
            toggle.querySelector('i').className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        });

        for (const input of [passwordInput, confirmInput]) {
            const wrap = input.closest('.field');
            const holder = document.createElement('div');
            holder.className = 'relative';
            wrap.insertBefore(holder, input);
            holder.appendChild(input);
        }
        passwordInput.closest('.field').querySelector('.relative').appendChild(toggle);

        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.id = 'submit-button';
        submit.className = 'btn btn-primary btn-block btn-lg mt-2';
        submit.textContent = 'Set new password';

        form.appendChild(submit);

        const backLink = document.createElement('p');
        backLink.className = 'text-sm text-stone-600 mt-6 text-center';
        backLink.innerHTML = `
            Changed your mind?
            <a href="/pages/auth/login.html" class="text-amber-700 font-medium hover:underline">Back to sign in</a>`;

        card.append(brand(), heading, subheading, alertBox, form, backLink);
        main.replaceChildren(card);
        passwordInput.focus();

        function fieldError(name) {
            return document.getElementById(`${name}-error`);
        }

        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            clearFieldErrors(form);
            alertBox.classList.add('hidden');

            const password = passwordInput.value;
            const confirmPassword = confirmInput.value;

            // Checked here so an obvious mistake costs no round trip. The
            // server enforces the same rules independently.
            if (!password || password.length < 8) {
                fieldError('password').textContent = 'Password must be at least 8 characters';
                passwordInput.focus();
                return;
            }

            if (password !== confirmPassword) {
                fieldError('confirmPassword').textContent = 'Passwords do not match';
                confirmInput.focus();
                return;
            }

            setButtonLoading(submit, true, 'Saving...');

            try {
                await authApi.resetPassword(token, password, confirmPassword);
                notify.success('Your password has been reset.');
                renderMessage({
                    icon: 'fa-circle-check',
                    tone: 'text-emerald-600',
                    title: 'Password updated',
                    body: 'You can now sign in with your new password.',
                    actions: [{ label: 'Sign in', href: '/pages/auth/login.html' }],
                });
            } catch (error) {
                setButtonLoading(submit, false);

                // A token that fails here passed the check on load but has been
                // consumed or expired since, so the only useful thing left is a
                // new link. A weak password is a field error instead, because
                // the guest can fix it by typing something else.
                if (['INVALID_OR_EXPIRED_TOKEN', 'TOKEN_MISSING'].includes(error.code)) {
                    renderMessage({
                        icon: 'fa-clock-rotate-left',
                        tone: 'text-amber-600',
                        title: 'This link is no longer valid',
                        body: 'It may already have been used. Request a new link and try again.',
                        actions: [{ label: 'Request a new link', href: '/pages/auth/forgot-password.html' }],
                    });
                    return;
                }

                if (error.errors?.password) {
                    fieldError('password').textContent = error.errors.password;
                } else if (error.errors?.confirmPassword) {
                    fieldError('confirmPassword').textContent = error.errors.confirmPassword;
                } else {
                    showAlert(alertBox, error.message, 'error');
                }
            }
        });
    }
}