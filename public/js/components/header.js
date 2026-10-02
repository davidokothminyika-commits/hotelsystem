/**
 * public/js/components/header.js
 *
 * WHAT THIS MODULE DOES
 * Wires up the shared header: resolves the session, switches between the
 * signed in and signed out states, builds the role aware account menu, and
 * keeps the notification badge current.
 *
 * WHY IT EXISTS
 * Every page needs the same header behaviour. Keeping it here means a page
 * only has to load the component, not reimplement the session logic.
 *
 * COMMUNICATION
 * Page -> loadComponent('#app-header', '/components/header.html')
 *      -> initHeader() -> GET /api/auth/me
 *                       -> POST /api/auth/logout on sign out
 *                       -> GET /api/notifications/unread-count for the badge
 */
import authApi from '../api/auth.js';
import api from '../api/api.js';
import { getElement, statusBadge } from '../lib/dom.js';

/** Where a signed in user of each role is sent after signing in. */
const ROLE_LANDING = {
    guest: '/pages/guest/dashboard.html',
    receptionist: '/pages/staff/reception.html',
    restaurant_staff: '/pages/staff/restaurant.html',
    housekeeping: '/pages/staff/housekeeping.html',
    manager: '/pages/admin/dashboard.html',
    admin: '/pages/admin/dashboard.html',
};

/** Menu links per role. Guests and staff get different navigation. */
function buildMenuLinks(role) {
    const guestLinks = [
        { href: '/pages/guest/dashboard.html', icon: 'fa-gauge', label: 'Dashboard' },
        { href: '/pages/guest/bookings.html', icon: 'fa-calendar-check', label: 'My bookings' },
        { href: '/pages/guest/orders.html', icon: 'fa-utensils', label: 'My orders' },
        { href: '/pages/guest/payments.html', icon: 'fa-credit-card', label: 'Payments' },
        { href: '/pages/guest/messages.html', icon: 'fa-comments', label: 'Messages' },
        { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        { href: '/pages/guest/settings.html', icon: 'fa-gear', label: 'Settings' },
    ];

    const staffLinks = {
        receptionist: [
            { href: '/pages/staff/reception.html', icon: 'fa-concierge-bell', label: 'Front desk' },
            { href: '/pages/guest/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Inbox' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ],
        restaurant_staff: [
            { href: '/pages/staff/restaurant.html', icon: 'fa-kitchen-set', label: 'Kitchen' },
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Inbox' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ],
        housekeeping: [
            { href: '/pages/staff/housekeeping.html', icon: 'fa-broom', label: 'Room status' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ],
        manager: [
            { href: '/pages/admin/dashboard.html', icon: 'fa-chart-line', label: 'Dashboard' },
            { href: '/pages/admin/bookings.html', icon: 'fa-calendar-check', label: 'Bookings' },
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/admin/reports.html', icon: 'fa-file-lines', label: 'Reports' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ],
        admin: [
            { href: '/pages/admin/dashboard.html', icon: 'fa-chart-line', label: 'Dashboard' },
            { href: '/pages/admin/users.html', icon: 'fa-users', label: 'Users' },
            { href: '/pages/admin/roles.html', icon: 'fa-shield-halved', label: 'Roles' },
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/admin/bookings.html', icon: 'fa-calendar-check', label: 'Bookings' },
            { href: '/pages/admin/menu.html', icon: 'fa-utensils', label: 'Menu' },
            { href: '/pages/admin/orders.html', icon: 'fa-receipt', label: 'Orders' },
            { href: '/pages/admin/payments.html', icon: 'fa-credit-card', label: 'Payments' },
            { href: '/pages/admin/reviews.html', icon: 'fa-star', label: 'Reviews' },
            { href: '/pages/admin/reports.html', icon: 'fa-file-lines', label: 'Reports' },
            { href: '/pages/admin/audit-logs.html', icon: 'fa-clipboard-list', label: 'Audit log' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ],
    };

    const links = staffLinks[role] || guestLinks;

    return links.map((link) => ({ ...link, role: 'menuitem' }));
}

/** Where to send a user after signing in. */
export function landingPageFor(role) {
    return ROLE_LANDING[role] || '/pages/guest/dashboard.html';
}

/**
 * Initialises the header.
 * Safe to call on every page: it no-ops if the header is not present.
 */
export async function initHeader() {
    const authContainer = getElement('#header-authenticated');
    const signedInContainer = getElement('#header-signed-in');
    if (!authContainer || !signedInContainer) return null;

    setupMobileMenu();
    setupMenuDismiss();

    let user;
    try {
        user = await authApi.me();
    } catch {
        // A failed session lookup should not block the page. Treat the visitor
        // as signed out so the header still renders.
        user = null;
    }

    if (!user) {
        authContainer.hidden = false;
        signedInContainer.hidden = true;
        markActiveNav();
        return null;
    }

    renderSignedIn(user);
    markActiveNav();
    startNotificationPolling(user.id);

    return user;
}

/** Fills in the signed in header state. */
function renderSignedIn(user) {
    getElement('#header-authenticated').hidden = true;

    const container = getElement('#header-signed-in');
    container.hidden = false;

    // Initials for the avatar. Falls back to '?' rather than a blank circle.
    const initials = `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase() || '?';
    const avatar = getElement('#user-avatar');
    avatar.textContent = initials;

    getElement('#user-display-name').textContent = user.firstName || user.email;
    getElement('#user-menu-email').textContent = user.email;
    getElement('#user-menu-role').textContent = String(user.role || '').replace('_', ' ');

    // Unverified accounts get a visible prompt, since some features need it.
    if (!user.emailVerified) {
        const badge = document.createElement('span');
        badge.className = 'ml-2 text-[11px] text-amber-400 underline decoration-dotted';
        badge.textContent = 'Unverified';
        badge.title = 'Verify your email address to secure your account';
        getElement('#user-menu-email').appendChild(badge);
    }

    buildMenu(user);
    setupUserMenu();
    setupLogout();
}

/** Populates the account dropdown with links appropriate to the role. */
function buildMenu(user) {
    const container = getElement('#user-menu-links');
    container.textContent = '';

    for (const link of buildMenuLinks(user.role)) {
        const anchor = document.createElement('a');
        anchor.href = link.href;
        anchor.className = 'flex items-center gap-3 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition';
        anchor.setAttribute('role', 'menuitem');

        const icon = document.createElement('i');
        icon.className = `fa-solid ${link.icon} w-4 text-stone-400`;
        icon.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.textContent = link.label;

        anchor.append(icon, label);
        container.appendChild(anchor);
    }
}

/** Opens and closes the account dropdown, with Escape and outside-click. */
function setupUserMenu() {
    const button = getElement('#user-menu-button');
    const menu = getElement('#user-menu');
    if (!button || !menu) return;

    const toggle = () => {
        const isOpen = !menu.classList.contains('hidden');
        menu.classList.toggle('hidden', isOpen);
        button.setAttribute('aria-expanded', String(!isOpen));
    };

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
    });

    // Close when focus or a click lands outside the menu.
    document.addEventListener('click', (event) => {
        if (!menu.contains(event.target) && !button.contains(event.target)) {
            menu.classList.add('hidden');
            button.setAttribute('aria-expanded', 'false');
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            button.setAttribute('aria-expanded', 'false');
            button.focus();
        }
    });
}

/** Signs the user out and returns to the login page. */
function setupLogout() {
    const button = getElement('#logout-button');
    if (!button) return;

    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await authApi.logout();
            // Full navigation rather than a fetch, so no cached state survives.
            window.location.href = '/pages/auth/login.html';
        } catch (error) {
            console.error('[header] Sign out failed:', error.message);
            button.disabled = false;
        }
    });
}

/** Mobile navigation drawer. */
function setupMobileMenu() {
    const button = getElement('#mobile-menu-button');
    const menu = getElement('#mobile-menu');
    if (!button || !menu) return;

    button.addEventListener('click', () => {
        const isOpen = !menu.classList.contains('hidden');
        menu.classList.toggle('hidden', isOpen);
        button.setAttribute('aria-expanded', String(!isOpen));
        button.setAttribute('aria-label', isOpen ? 'Open menu' : 'Close menu');
    });
}

/** Closes transient UI when Escape is pressed anywhere. */
function setupMenuDismiss() {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const menu = getElement('#user-menu');
        const button = getElement('#user-menu-button');
        if (menu && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            button?.setAttribute('aria-expanded', 'false');
        }
    });
}

/** Highlights the nav item matching the current page. */
function markActiveNav() {
    const current = window.location.pathname;
    for (const link of document.querySelectorAll('[data-nav]')) {
        const target = link.getAttribute('href');
        if (current === target || (target !== '/' && current.startsWith(target))) {
            link.classList.add('text-white', 'bg-white/5');
            link.classList.remove('text-stone-300');
        }
    }
}

/**
 * Keeps the notification badge current.
 *
 * Polling rather than WebSockets, as the brief allows: a REST call every
 * minute is far simpler and adequate for an inbox indicator. The interval is
 * cleared when the tab is hidden, because a background tab does not need to
 * poll, and paused timers save both battery and database load.
 */
function startNotificationPolling(userId) {
    void userId;

    const button = getElement('#notification-button');
    const badge = getElement('#notification-badge');
    if (!button) return;

    button.hidden = false;

    button.addEventListener('click', () => {
        window.location.href = '/pages/guest/notifications.html';
    });

    async function refresh() {
        try {
            const result = await api.get('/notifications/unread-count');
            const count = result?.data?.count || 0;

            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.classList.remove('hidden');
                button.setAttribute('aria-label', `Notifications, ${count} unread`);
            } else {
                badge.classList.add('hidden');
                button.setAttribute('aria-label', 'Notifications');
            }
        } catch {
            // A failed poll is not worth surfacing; the next tick retries.
        }
    }

    refresh();
    const timer = setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
    }, 60_000);

    // Refresh immediately when the tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });

    return () => clearInterval(timer);
}

export default { initHeader, landingPageFor };