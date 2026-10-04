/**
 * public/js/app.js
 *
 * WHAT THIS MODULE DOES
 * The shared entry point every page loads. It loads the header, footer and
 * sidebar fragments, initialises them, and provides the utilities pages rely
 * on.
 *
 * WHY IT EXISTS
 * Without it, each page would repeat the same bootstrap sequence, and any
 * change to how components load would need applying everywhere.
 *
 * USAGE FROM A PAGE
 *
 *   <div id="app-header"></div>
 *   <main>...</main>
 *   <div id="app-footer"></div>
 *
 *   <script type="module">
 *       import { initApp, requireAuth } from '/js/app.js';
 *       await initApp();
 *   </script>
 *
 * COMMUNICATION
 * Page -> initApp() -> loader.js (fetches components) -> header.js, sidebar.js
 */
import { loadComponent, loadComponents } from './components/loader.js';
import { initHeader } from './components/header.js';
import { initMotion } from './lib/motion.js';
import { setUnauthenticatedHandler } from './api/api.js';

export { loadComponent, loadComponents };
export { initMotion, observe as observeMotion, stagger, countUp } from './lib/motion.js';

/**
 * Loads and initialises the shared page furniture.
 *
 * @param {object} [options]
 * @param {boolean} [options.footer=true]  Load the site footer.
 * @param {boolean} [options.sidebar=false] Load the dashboard sidebar.
 * @returns {Promise<{user: object|null}>} The current user, or null.
 */
export async function initApp(options = {}) {
    const { footer = true, sidebar = false } = options;

    // Root-relative paths. See components/loader.js for why these must be
    // absolute from the origin rather than relative to the current page.
    const parts = [
        loadComponent('#app-header', '/components/header.html'),
        loadComponent('#modal-root-slot', '/components/modal.html', { cache: true }),
    ];

    if (footer) {
        parts.push(loadComponent('#app-footer', '/components/footer.html'));
    }

    if (sidebar) {
        parts.push(loadComponent('#app-sidebar', '/components/sidebar.html'));
    }

    // Components fetch in parallel so the page appears in one step.
    await Promise.all(parts);

    // Started before anything else so content rendered from here on animates in
    // as it arrives rather than appearing fully settled.
    initMotion();

    const user = await initHeader();
    initFooter();

    // A 401 from anywhere in the app returns the user to sign in, except on
    // the pages where that would be a confusing redirect loop.
    setUnauthenticatedHandler(handleUnauthenticated);

    return { user };
}

/** Fills in the dynamic bits of the footer. */
function initFooter() {
    const year = document.getElementById('footer-year');
    if (year) year.textContent = String(new Date().getFullYear());
}

/**
 * Handles a 401 raised anywhere in the application.
 *
 * The current page is remembered so sign in can return the user to where they
 * were, rather than dumping them on a dashboard.
 */
function handleUnauthenticated(error) {
    if (error?.code === 'NO_TOKEN' || error?.status === 401) {
        const currentPath = window.location.pathname + window.location.search;

        // Already on an auth page: redirecting again would loop.
        if (currentPath.includes('/pages/auth/')) return;

        const returnTo = encodeURIComponent(currentPath);
        window.location.href = `/pages/auth/login.html?returnTo=${returnTo}`;
    }
}

/**
 * Requires a session, redirecting to sign in when there is none.
 * Use on pages that only make sense for a signed in user.
 *
 * @returns {Promise<object|null>} The user, or null after a redirect.
 */
export async function requireAuth() {
    const { default: authApi } = await import('./api/auth.js');
    const user = await authApi.me();

    if (!user) {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/pages/auth/login.html?returnTo=${returnTo}`;
        return null;
    }

    return user;
}

/**
 * Requires one of the given roles, redirecting otherwise.
 *
 * @param {string[]} roles
 * @returns {Promise<object|null>} The user if permitted, otherwise null.
 */
export async function requireRole(roles) {
    const user = await requireAuth();
    if (!user) return null;

    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(user.role)) {
        // Not a 403 message in the URL: the user lands on their own dashboard
        // rather than on an error page they cannot act on.
        const { landingPageFor } = await import('./components/header.js');
        window.location.href = landingPageFor(user.role);
        return null;
    }

    return user;
}

/** Convenience re-exports so pages import from one place. */
export { initHeader };
export { default as notify, showAlert, showFieldErrors, clearFieldErrors } from './components/notification.js';
export { default as modal } from './components/modal.js';
export * from './lib/dom.js';