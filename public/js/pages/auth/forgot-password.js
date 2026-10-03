/**
 * public/js/pages/auth/forgot-password.js
 *
 * WHAT THIS MODULE DOES
 * Asks for an email address and requests a password reset link.
 *
 * WHY IT EXISTS
 * The page has to work for someone who cannot sign in, so it deliberately has
 * no dashboard shell: buildShell would require a session and redirect straight
 * back to the login form, making the page unreachable for exactly the people
 * who need it. It uses initApp for the header and footer only.
 *
 * WHY THE RESPONSE SAYS NOTHING ABOUT WHETHER THE ACCOUNT EXISTS
 * The server answers with the same message whether or not the address is
 * registered. Confirming an address here would let anyone test whether a given
 * person has an account, so this page reports the same thing the server said
 * rather than inventing a friendlier or more specific answer.
 *
 * COMMUNICATION
 * Page -> POST /api/auth/forgot-password { email }
 *      -> GET  /api/auth/me, to skip the form for a signed in visitor
 */
import { initApp } from '../../app.js';
import authApi from '../../api/auth.js';
import { landingPageFor } from '../../components/header.js';
import { showAlert, clearFieldErrors } from '../../components/notification.js';
import { getQueryParam, setButtonLoading } from '../../lib/dom.js';

await initApp({ footer: true, sidebar: false });

const main = document.createElement('main');
main.className = 'flex items-center justify-center px-4 py-16';

// ---- Already signed in? The reset link would be pointless. ----
const existingUser = await authApi.me();
if (existingUser) {
    const message = document.createElement('p');
    message.className = 'text-sm text-stone-600';
    message.textContent = 'Taking you to your dashboard...';
    main.appendChild(message);
    document.body.appendChild(main);
    window.location.replace(landingPageFor(existingUser.role));
} else {
    // =====================================================================
    // Form
    // =====================================================================
    const card = document.createElement('div');
    card.className = 'w-full max-w-md bg-white rounded-xl border border-stone-200 shadow-sm p-6 sm:p-8';

    const brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'inline-flex items-center gap-2.5 mb-8';
    brand.innerHTML = `
        <span class="flex items-center justify-center w-10 h-10 rounded-lg bg-amber-600 text-stone-900">
            <i class="fa-solid fa-hotel" aria-hidden="true"></i>
        </span>
        <span>
            <span class="block text-base font-semibold text-stone-900 leading-tight">Aurelia Grand Hotel</span>
            <span class="block text-xs text-stone-500">Nairobi, Kenya</span>
        </span>`;

    const heading = document.createElement('h1');
    heading.className = 'text-2xl font-bold text-stone-900 mb-1';
    heading.textContent = 'Reset your password';

    const subheading = document.createElement('p');
    subheading.className = 'text-sm text-stone-500 mb-8';
    subheading.textContent = 'Enter the email address you booked with and we will send you a reset link.';

    const alertBox = document.createElement('div');
    alertBox.className = 'hidden rounded-lg border px-4 py-3 text-sm mb-5';
    alertBox.setAttribute('role', 'alert');

    const form = document.createElement('form');
    form.id = 'forgot-password-form';
    form.noValidate = true;

    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('label');
    label.className = 'form-label';
    label.setAttribute('for', 'email');
    label.textContent = 'Email address';

    const input = document.createElement('input');
    input.type = 'email';
    input.id = 'email';
    input.name = 'email';
    input.className = 'form-input';
    input.autocomplete = 'email';
    input.required = true;
    input.placeholder = 'you@example.com';

    const error = document.createElement('p');
    error.className = 'form-error';
    error.id = 'email-error';

    field.append(label, input, error);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.id = 'submit-button';
    submit.className = 'btn btn-primary btn-block btn-lg mt-2';
    submit.textContent = 'Send reset link';

    form.append(field, submit);

    const backLink = document.createElement('p');
    backLink.className = 'text-sm text-stone-600 mt-6 text-center';
    backLink.innerHTML = `
        Remembered it?
        <a href="/pages/auth/login.html" class="text-amber-700 font-medium hover:underline">Back to sign in</a>`;

    // ---- Confirmation, replacing the form once the request is accepted ----
    const sent = document.createElement('div');
    sent.className = 'hidden text-center';

    const sentIcon = document.createElement('i');
    sentIcon.className = 'fa-solid fa-envelope-circle-check text-4xl text-emerald-600 mb-4';
    sentIcon.setAttribute('aria-hidden', 'true');

    const sentTitle = document.createElement('h1');
    sentTitle.className = 'text-xl font-bold text-stone-900 mb-2';
    sentTitle.textContent = 'Check your inbox';

    const sentBody = document.createElement('p');
    sentBody.className = 'text-sm text-stone-500 mb-6';

    const sentAgain = document.createElement('button');
    sentAgain.type = 'button';
    sentAgain.className = 'btn btn-outline';
    sentAgain.textContent = 'Send to a different address';

    sent.append(sentIcon, sentTitle, sentBody, sentAgain);

    card.append(brand, heading, subheading, alertBox, form, sent, backLink);
    main.appendChild(card);
    document.body.appendChild(main);

    // =====================================================================
    // Behaviour
    // =====================================================================

    /** Shows the submitted address back, so the guest knows what to look for. */
    function showConfirmation(email) {
        form.hidden = true;
        heading.textContent = 'Reset link requested';
        subheading.hidden = true;
        sentBody.textContent = `If an account exists for ${email}, a reset link is on its way. The link expires in one hour.`;
        sent.classList.remove('hidden');
        sentAgain.focus();
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        clearFieldErrors(form);
        alertBox.classList.add('hidden');

        const email = input.value.trim();

        // Checked here so an obvious typo does not cost a round trip. The
        // server validates the same rule independently.
        if (!email) {
            showAlert(alertBox, 'Enter the email address on your account.', 'error');
            return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            error.textContent = 'Enter a valid email address.';
            input.focus();
            return;
        }

        setButtonLoading(submit, true, 'Sending...');

        try {
            const result = await authApi.forgotPassword(email);
            showConfirmation(email);
        } catch (err) {
            setButtonLoading(submit, false);

            // A validation error from the server belongs on the field; anything
            // else is shown at the form level.
            if (err.errors?.email) {
                error.textContent = err.errors.email;
                input.focus();
            } else {
                showAlert(alertBox, err.message, 'error');
            }
        }
    });

    // A second request is a fresh start, so the form is rebuilt rather than
    // re-submitted with whatever is still in it.
    sentAgain.addEventListener('click', () => {
        sent.classList.add('hidden');
        form.hidden = false;
        heading.textContent = 'Reset your password';
        subheading.hidden = false;
        input.value = '';
        error.textContent = '';
        setButtonLoading(submit, false);
        input.focus();
    });

    // A guest who came here to recover an account reaches this page from the
    // sign-in form, so start with the field focused.
    if (getQueryParam('email')) {
        input.value = getQueryParam('email');
    }
    input.focus();
}