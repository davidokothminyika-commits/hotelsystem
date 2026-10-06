/**
 * public/js/components/shell.js
 *
 * WHAT THIS MODULE DOES
 * Builds the standard dashboard layout: sidebar, top bar and content area.
 *
 * WHY THIS EXISTS
 * Every signed in page (guest, reception, housekeeping, restaurant, admin)
 * needs the same shell. Without it, each page would repeat the layout markup
 * and, more importantly, each would resolve the session and load the sidebar
 * slightly differently.
 *
 * It also removes a whole class of bug: a page that forgets to call
 * `requireAuth` would render an empty shell. Building the shell through this
 * helper makes the auth check part of the construction, so it cannot be
 * skipped by accident.
 *
 * COMMUNICATION
 * Page -> buildShell({ title }) -> returns { user, content }
 *        -> requireAuth() / requireRole()
 *        -> initSidebar(user)
 */
import { initApp, requireAuth, requireRole } from '../app.js';
import { brandName } from './branding.js';
import { initSidebar } from './sidebar.js';
import { getElement } from '../lib/dom.js';

/**
 * Builds the dashboard shell and returns the content container.
 *
 * @param {object} options
 * @param {string} options.title      Page title, also set on document.title.
 * @param {string} [options.subtitle] Small text under the title.
 * @param {string[]} [options.roles]  Restrict to these roles. Omit for any user.
 * @param {boolean} [options.header=false] Render a page header above the content.
 * @returns {Promise<{user: object, content: HTMLElement}>}
 *   Resolves with null-user when redirected, so callers can `if (!shell) return;`
 */
export async function buildShell({ title, subtitle = '', roles = [], header = true }) {
    // Establish the session before anything renders, so a redirect happens
    // immediately rather than after a flash of an empty dashboard.
    const user = roles.length ? await requireRole(roles) : await requireAuth();
    if (!user) return { user: null, content: null };

    await initApp({ footer: false, sidebar: true });
    initSidebar(user);

    // The configured hotel name, not a hard coded one: the branding has
    // already loaded by this point because initApp ran above.
    document.title = `${title} | ${brandName()}`;

    const root = document.getElementById('app-root');
    if (!root) {
        console.error('[shell] No #app-root element found on the page');
        return { user, content: null };
    }

    const icons = {
        dashboard: 'fa-gauge',
        bookings: 'fa-calendar-check',
        orders: 'fa-utensils',
        payments: 'fa-credit-card',
        rooms: 'fa-bed',
        restaurant: 'fa-utensils',
        reviews: 'fa-star',
        messages: 'fa-comments',
        profile: 'fa-user',
        notifications: 'fa-bell',
        users: 'fa-users',
        reports: 'fa-file-lines',
        rooms_admin: 'fa-bed',
        menu: 'fa-utensils',
    };

    root.textContent = '';
    root.className = 'page-shell';

    // ---- Sidebar ----
    const sidebarContainer = document.createElement('div');
    sidebarContainer.className = 'contents';
    sidebarContainer.id = 'app-sidebar-slot';
    root.appendChild(sidebarContainer);

    // The sidebar component lives in the document; move it into the shell so
    // the flex layout places it correctly.
    const sidebar = document.getElementById('app-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebarContainer.appendChild(sidebar);
    if (overlay) sidebarContainer.appendChild(overlay);

    // ---- Main column ----
    const main = document.createElement('div');
    main.className = 'main-content flex flex-col min-h-screen bg-stone-50';

    if (header) {
        const bar = document.createElement('div');
        bar.className = 'bg-white border-b border-stone-200 px-4 sm:px-6 py-4';

        const inner = document.createElement('div');
        inner.className = 'flex flex-wrap items-center justify-between gap-3';

        const titleWrap = document.createElement('div');
        const heading = document.createElement('h1');
        heading.className = 'text-xl font-bold text-stone-900';
        heading.textContent = title;
        titleWrap.appendChild(heading);

        if (subtitle) {
            const sub = document.createElement('p');
            sub.className = 'text-sm text-stone-500 mt-0.5';
            sub.textContent = subtitle;
            titleWrap.appendChild(sub);
        }

        // Pages can supply their own controls in this slot.
        const actions = document.createElement('div');
        actions.id = 'page-actions';
        actions.className = 'flex flex-wrap items-center gap-2';

        inner.append(titleWrap, actions);
        bar.appendChild(inner);
        main.appendChild(bar);
    }

    // ---- Content ----
    const content = document.createElement('div');
    content.id = 'page-content';
    // page-content-enter settles the content area in. The cards inside it are
    // handled by lib/motion.js as they are rendered, so this only needs to set
    // the frame they arrive into rather than animating a blank panel.
    content.className = 'flex-1 p-4 sm:p-6 page-content-enter';
    main.appendChild(content);

    root.appendChild(main);

    return { user, content };
}

/**
 * Adds a button to the page header action area.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string} [options.icon]   Font Awesome class.
 * @param {string} [options.variant='primary'] 'primary'|'outline'|'ghost'
 * @param {string} [options.href]    Renders an anchor instead of a button.
 * @param {Function} [options.onClick]
 * @returns {HTMLElement|null}
 */
export function addHeaderAction({ label, icon, variant = 'primary', href, onClick }) {
    const container = getElement('#page-actions');
    if (!container) return null;

    // Only complete class literals, never interpolated, because the Tailwind
    // CDN cannot see class names generated at runtime.
    const VARIANTS = {
        primary: 'btn btn-primary',
        outline: 'btn btn-outline',
        ghost: 'btn btn-ghost',
    };

    const element = document.createElement(href ? 'a' : 'button');
    element.className = VARIANTS[variant] || VARIANTS.primary;
    if (href) element.href = href;
    if (!href) element.type = 'button';

    if (icon) {
        const iconEl = document.createElement('i');
        iconEl.className = `fa-solid ${icon}`;
        iconEl.setAttribute('aria-hidden', 'true');
        element.appendChild(iconEl);
    }

    element.appendChild(document.createTextNode(label));
    if (onClick) element.addEventListener('click', onClick);

    container.appendChild(element);
    return element;
}

export default { buildShell, addHeaderAction };