/**
 * public/js/pages/auth/verify-email.js
 *
 * WHAT THIS MODULE DOES
 * Confirms a newly registered email address from the link in the verification
 * message.
 *
 * WHY IT VERIFIES AUTOMATICALLY
 * There is nothing to fill in. The visitor clicked a link and the only useful
 * outcome is a result, so the page shows progress and then the answer rather
 * than a button asking them to press something they have already agreed to.
 *
 * WHY IT OFFERS A RESEND WHEN IT CAN
 * An expired or already-used link is the common case. If the visitor already has
 * a session, `resendVerification` can send a fresh one; if they do not, there
 * is no account to act for, so it sends them to sign in instead of pretending
 * the button will work.
 *
 * COMMUNICATION
 * Page -> POST /api/auth/verify-email         { token }
 *      -> POST /api/auth/resend-verification  (only when signed in)
 *      -> GET  /api/auth/me, to decide whether a resend is possible
 * Database tables used: email_verification_tokens, users, audit_logs
 */
import { initApp } from '../../app.js';
import authApi from '../../api/auth.js';
import { landingPageFor } from '../../components/header.js';
import notify from '../../components/notification.js';
import { getQueryParam, setButtonLoading } from '../../lib/dom.js';

await initApp({ footer: true, sidebar: false });

const main = document.createElement('main');
main.id = 'main-content';
main.className = 'flex items-center justify-center px-4 py-16';
document.body.appendChild(main);

const token = getQueryParam('token');

// =====================================================================
// Render helpers
// =====================================================================
function card() {
    const element = document.createElement('div');
    element.className = 'w-full max-w-md bg-white rounded-xl border border-stone-200 shadow-sm p-6 sm:p-8 text-center';
    return element;
}

function renderOutcome({ icon, tone, title, body, actions = [] }) {
    const element = card();

    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon} text-4xl mb-4 ${tone}`;
    glyph.setAttribute('aria-hidden', 'true');

    const heading = document.createElement('h1');
    heading.className = 'text-xl font-bold text-stone-900 mb-2';
    heading.textContent = title;

    const paragraph = document.createElement('p');
    paragraph.className = 'text-sm text-stone-500';
    paragraph.textContent = body;

    element.append(glyph, heading, paragraph);

    if (actions.length) {
        const row = document.createElement('div');
        row.className = 'mt-6 flex flex-col sm:flex-row gap-2 justify-center';
        for (const action of actions) {
            const link = document.createElement('a');
            link.href = action.href;
            link.className = `btn ${action.variant || 'btn-primary'} btn-block sm:w-auto`;
            link.textContent = action.label;
            row.appendChild(link);
        }
        element.appendChild(row);
    }

    main.replaceChildren(element);
}

/** The button that asks for a fresh verification message. */
function resendButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline btn-block sm:w-auto';
    button.textContent = 'Send a new link';
    return button;
}

// =====================================================================
// Progress
// =====================================================================
if (!token) {
    renderOutcome({
        icon: 'fa-link-slash',
        tone: 'text-stone-400',
        title: 'This link is incomplete',
        body: 'The verification link is missing its token. Sign in and request a new one from your profile.',
        actions: [{ label: 'Sign in', href: '/pages/auth/login.html' }],
    });
} else {
    const working = document.createElement('div');
    working.className = 'text-center text-stone-500 flex flex-col items-center gap-3';
    working.innerHTML = `
        <i class="fa-solid fa-spinner fa-spin text-2xl" aria-hidden="true"></i>
        <p class="text-sm">Verifying your email...</p>`;
    main.replaceChildren(working);

    try {
        await authApi.verifyEmail(token);

        // Worth checking for a session: somebody who already signed in is
        // better sent to their dashboard than to another sign-in form.
        const user = await authApi.me().catch(() => null);

        renderOutcome({
            icon: 'fa-envelope-circle-check',
            tone: 'text-emerald-600',
            title: 'Email verified',
            body: 'Your email address is confirmed. Nothing else to do.',
            actions: [
                user
                    ? { label: 'Go to your dashboard', href: landingPageFor(user.role) }
                    : { label: 'Sign in', href: '/pages/auth/login.html' },
            ],
        });
    } catch {
        // The token is spent, expired or malformed. All three need the same
        // remedy, and none of them should say which, since that would let
        // someone probe whether a token ever existed.
        const user = await authApi.me().catch(() => null);

        const element = card();

        const glyph = document.createElement('i');
        glyph.className = 'fa-solid fa-envelope-circle-exclamation text-4xl mb-4 text-amber-600';
        glyph.setAttribute('aria-hidden', 'true');

        const heading = document.createElement('h1');
        heading.className = 'text-xl font-bold text-stone-900 mb-2';
        heading.textContent = 'This link no longer works';

        const paragraph = document.createElement('p');
        paragraph.className = 'text-sm text-stone-500';
        paragraph.textContent = user
            ? 'Verification links can only be used once and last 24 hours. We can send you a new one.'
            : 'Verification links can only be used once and last 24 hours. Sign in to request a new one.';

        element.append(glyph, heading, paragraph);

        const row = document.createElement('div');
        row.className = 'mt-6 flex flex-col sm:flex-row gap-2 justify-center';

        if (user) {
            const button = resendButton();

            button.addEventListener('click', async () => {
                setButtonLoading(button, true, 'Sending...');
                try {
                    await authApi.resendVerification();
                    notify.success('A new verification link is on its way.');
                    setButtonLoading(button, false);
                    button.textContent = 'Sent. Check your inbox.';
                    button.disabled = true;
                } catch (error) {
                    setButtonLoading(button, false);
                    notify.error(error.message);
                }
            });

            row.appendChild(button);
        }

        const signIn = document.createElement('a');
        signIn.href = '/pages/auth/login.html';
        signIn.className = `btn ${user ? 'btn-outline' : 'btn-primary'} btn-block sm:w-auto`;
        signIn.textContent = 'Sign in';
        row.appendChild(signIn);

        element.appendChild(row);
        main.replaceChildren(element);
    }
}