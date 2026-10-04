/**
 * public/js/components/sidebar.js
 *
 * WHAT THIS MODULE DOES
 * Renders dashboard navigation for the signed in user's role, and handles
 * collapsing on desktop and the drawer on mobile.
 *
 * WHY IT EXISTS
 * Six roles need six different sets of navigation. Rendering them from data
 * means one sidebar component serves all six, and adding a screen is a data
 * change rather than a new HTML file.
 *
 * COMMUNICATION
 * initSidebar(user) -> reads the role -> renders nav -> highlights current page
 */
import authApi from '../api/auth.js';
import { getElement } from '../lib/dom.js';

/** Navigation definition per role. */
const NAVIGATION = {
    guest: [
        { section: 'Overview', items: [
            { href: '/pages/guest/dashboard.html', icon: 'fa-gauge', label: 'Dashboard' },
        ]},
        { section: 'My stay', items: [
            { href: '/pages/guest/bookings.html', icon: 'fa-calendar-check', label: 'My bookings' },
            { href: '/pages/guest/orders.html', icon: 'fa-utensils', label: 'My orders' },
            { href: '/pages/guest/payments.html', icon: 'fa-credit-card', label: 'Payments' },
            { href: '/pages/guest/invoices.html', icon: 'fa-file-invoice', label: 'Invoices' },
        ]},
        { section: 'Discover', items: [
            { href: '/pages/guest/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/guest/restaurant.html', icon: 'fa-utensils', label: 'Restaurant' },
            { href: '/pages/guest/reviews.html', icon: 'fa-star', label: 'Reviews' },
        ]},
        { section: 'Account', items: [
            { href: '/pages/guest/messages.html', icon: 'fa-comments', label: 'Messages' },
            { href: '/pages/guest/notifications.html', icon: 'fa-bell', label: 'Notifications' },
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
            { href: '/pages/guest/settings.html', icon: 'fa-gear', label: 'Settings' },
        ]},
    ],

    receptionist: [
        { section: 'Front desk', items: [
            { href: '/pages/staff/reception.html', icon: 'fa-concierge-bell', label: 'Front desk' },
            { href: '/pages/admin/bookings.html', icon: 'fa-calendar-check', label: 'All bookings' },
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'Room status' },
        ]},
        { section: 'Guests', items: [
            { href: '/pages/admin/users.html', icon: 'fa-users', label: 'Guest directory' },
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Inbox' },
        ]},
        { section: 'Billing', items: [
            { href: '/pages/admin/payments.html', icon: 'fa-credit-card', label: 'Payments' },
            { href: '/pages/admin/invoices.html', icon: 'fa-file-invoice', label: 'Invoices' },
        ]},
        { section: 'Account', items: [
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ]},
    ],

    restaurant_staff: [
        { section: 'Kitchen', items: [
            { href: '/pages/staff/restaurant.html', icon: 'fa-kitchen-set', label: 'Order board' },
            { href: '/pages/admin/orders.html', icon: 'fa-receipt', label: 'All orders' },
            { href: '/pages/admin/menu.html', icon: 'fa-utensils', label: 'Menu' },
        ]},
        { section: 'Guests', items: [
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Inbox' },
        ]},
        { section: 'Account', items: [
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ]},
    ],

    housekeeping: [
        { section: 'Operations', items: [
            { href: '/pages/staff/housekeeping.html', icon: 'fa-broom', label: 'Room status' },
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'All rooms' },
        ]},
        { section: 'Account', items: [
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ]},
    ],

    manager: [
        { section: 'Overview', items: [
            { href: '/pages/admin/dashboard.html', icon: 'fa-chart-line', label: 'Dashboard' },
            { href: '/pages/admin/reports.html', icon: 'fa-file-lines', label: 'Reports' },
        ]},
        { section: 'Operations', items: [
            { href: '/pages/admin/bookings.html', icon: 'fa-calendar-check', label: 'Bookings' },
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/admin/orders.html', icon: 'fa-receipt', label: 'Orders' },
            { href: '/pages/admin/payments.html', icon: 'fa-credit-card', label: 'Payments' },
        ]},
        { section: 'Guests', items: [
            { href: '/pages/admin/users.html', icon: 'fa-users', label: 'Users' },
            { href: '/pages/admin/reviews.html', icon: 'fa-star', label: 'Reviews' },
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Inbox' },
        ]},
        { section: 'Account', items: [
            { href: '/pages/guest/profile.html', icon: 'fa-user', label: 'Profile' },
        ]},
    ],

    admin: [
        { section: 'Overview', items: [
            { href: '/pages/admin/dashboard.html', icon: 'fa-chart-line', label: 'Dashboard' },
            { href: '/pages/admin/reports.html', icon: 'fa-file-lines', label: 'Reports' },
        ]},
        { section: 'Access', items: [
            { href: '/pages/admin/users.html', icon: 'fa-users', label: 'Users' },
            { href: '/pages/admin/roles.html', icon: 'fa-shield-halved', label: 'Roles' },
        ]},
        { section: 'Operations', items: [
            { href: '/pages/admin/rooms.html', icon: 'fa-bed', label: 'Rooms' },
            { href: '/pages/admin/bookings.html', icon: 'fa-calendar-check', label: 'Bookings' },
            { href: '/pages/admin/orders.html', icon: 'fa-receipt', label: 'Orders' },
            { href: '/pages/admin/menu.html', icon: 'fa-utensils', label: 'Menu' },
            { href: '/pages/admin/payments.html', icon: 'fa-credit-card', label: 'Payments' },
        ]},
        { section: 'Content', items: [
            { href: '/pages/admin/reviews.html', icon: 'fa-star', label: 'Reviews' },
            { href: '/pages/staff/messages.html', icon: 'fa-inbox', label: 'Messages' },
            { href: '/pages/admin/notifications.html', icon: 'fa-bell', label: 'Notifications' },
        ]},
        { section: 'System', items: [
            { href: '/pages/admin/audit-logs.html', icon: 'fa-clipboard-list', label: 'Audit log' },
            { href: '/pages/admin/settings.html', icon: 'fa-gear', label: 'Settings' },
        ]},
    ],
};

/**
 * Renders the sidebar for a user.
 *
 * @param {object} user The signed in user, or null.
 */
export function initSidebar(user) {
    const nav = getElement('#sidebar-nav');
    const sidebar = getElement('#app-sidebar');
    if (!nav || !sidebar) return;

    const items = NAVIGATION[user?.role] || NAVIGATION.guest;

    nav.textContent = '';

    // Links are numbered across the whole role, not per section, so the
    // navigation fills in as one sequence rather than restarting per heading.
    let linkIndex = 0;

    for (const group of items) {
        const title = document.createElement('p');
        title.className = 'nav-section-title';
        title.textContent = group.section;
        nav.appendChild(title);

        for (const item of group.items) {
            const link = buildNavLink(item);
            link.style.setProperty('--reveal-delay', `${Math.min(linkIndex, 10) * 30}ms`);
            linkIndex += 1;
            nav.appendChild(link);
        }
    }

    // Identity in the footer of the sidebar.
    if (user) {
        const initials = `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase() || '?';
        getElement('#sidebar-avatar').textContent = initials;
        getElement('#sidebar-name').textContent = `${user.firstName} ${user.lastName}`.trim();
        getElement('#sidebar-email').textContent = user.email;
        getElement('#sidebar-role').textContent = String(user.role).replace('_', ' ');
    }

    highlightCurrent(items);
    setupCollapse();
    setupLogout();
}

/**
 * Signs the user out from the sidebar footer.
 *
 * The header already offers a sign out inside the account dropdown, but on a
 * phone that menu is behind two taps and the dropdown closes on any outside
 * click, so it is easy to lose. The sidebar footer is always on screen, which
 * makes it the reliable way out of the dashboard.
 */
function setupLogout() {
    const button = getElement('#sidebar-logout');
    if (!button) return;

    button.addEventListener('click', async () => {
        button.disabled = true;

        // Confirm while the request is in flight so the button cannot be
        // double-clicked into two sign out calls.
        const label = button.querySelector('.nav-label');
        if (label) label.textContent = 'Signing out...';

        try {
            await authApi.logout();
            // A full navigation, not a client side redirect, so no cached
            // page state or in-memory user object survives the sign out.
            window.location.href = '/pages/auth/login.html';
        } catch (error) {
            console.error('[sidebar] Sign out failed:', error.message);
            button.disabled = false;
            if (label) label.textContent = 'Sign out';
        }
    });
}

/** Builds one navigation link. */
function buildNavLink(item) {
    const anchor = document.createElement('a');
    anchor.href = item.href;
    anchor.className = 'nav-link';
    // Used by highlightCurrent to identify the active page.
    anchor.dataset.href = item.href;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${item.icon} w-4 text-center shrink-0`;
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = item.label;

    anchor.append(icon, label);
    return anchor;
}

/** Marks the link matching the current path as active. */
function highlightCurrent() {
    const current = window.location.pathname;

    for (const link of document.querySelectorAll('#sidebar-nav .nav-link')) {
        const href = link.dataset.href;
        const isActive = current === href || (href !== '/pages/guest/dashboard.html' && current.startsWith(href));

        link.classList.toggle('is-active', isActive);
        if (isActive) {
            // aria-current tells assistive technology which page is active.
            link.setAttribute('aria-current', 'page');
        } else {
            link.removeAttribute('aria-current');
        }
    }
}

/**
 * Collapse behaviour.
 *
 * Desktop (1024px and up): toggles between a full sidebar and a narrow icon
 * rail. The state is remembered in localStorage because it is a display
 * preference, not data, so storing it there is appropriate and safe.
 *
 * Below 1024px the sidebar becomes an off-canvas drawer instead, toggled with
 * the .is-open class.
 */
function setupCollapse() {
    const toggle = getElement('#sidebar-toggle');
    const sidebar = getElement('#app-sidebar');
    const overlay = getElement('#sidebar-overlay');
    if (!toggle || !sidebar) return;

    const STORAGE_KEY = 'hotel.sidebar.collapsed';
    const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

    // Restore the desktop preference.
    if (localStorage.getItem(STORAGE_KEY) === 'true' && isDesktop()) {
        sidebar.classList.add('is-collapsed');
        toggle.setAttribute('aria-label', 'Expand sidebar');
    }

    function setCollapsed(collapsed) {
        sidebar.classList.toggle('is-collapsed', collapsed);
        toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem(STORAGE_KEY, String(collapsed));
    }

    function setDrawerOpen(open) {
        sidebar.classList.toggle('is-open', open);
        overlay?.classList.toggle('is-visible', open);
        toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
        toggle.setAttribute('aria-expanded', String(open));
    }

    toggle.addEventListener('click', () => {
        if (isDesktop()) {
            setCollapsed(!sidebar.classList.contains('is-collapsed'));
        } else {
            setDrawerOpen(!sidebar.classList.contains('is-open'));
        }
    });

    // Clicking the dimmed area closes the mobile drawer.
    overlay?.addEventListener('click', () => setDrawerOpen(false));

    // Escape closes the drawer.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
            setDrawerOpen(false);
            toggle.focus();
        }
    });

    // Crossing the breakpoint must not leave a half-applied state.
    window.matchMedia('(min-width: 1024px)').addEventListener('change', () => {
        sidebar.classList.remove('is-open');
        overlay?.classList.remove('is-visible');
    });

    // A link click should close the mobile drawer.
    nav_autoClose(sidebar);
}

function nav_autoClose(sidebar) {
    document.getElementById('sidebar-nav')?.addEventListener('click', (event) => {
        if (event.target.closest('.nav-link') && window.matchMedia('(max-width: 1023px)').matches) {
            sidebar.classList.remove('is-open');
            document.getElementById('sidebar-overlay')?.classList.remove('is-visible');
        }
    });
}

export default { initSidebar };