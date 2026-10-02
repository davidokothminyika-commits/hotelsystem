/**
 * public/js/lib/dom.js
 *
 * WHAT THIS MODULE DOES
 * Small DOM utilities shared by every component: element lookup, safe HTML
 * escaping, date and money formatting, and building elements from data.
 *
 * WHY IT EXISTS
 * Two reasons:
 *
 *   1. SAFETY. The API returns data a guest typed, such as a name or a review
 *      comment. Inserting that with innerHTML would allow stored XSS, so
 *      anything from the API is inserted with textContent or escaped first.
 *      Having one escapeHtml makes the safe path the easy path.
 *
 *   2. CONSISTENCY. Formatting a date or an amount is done the same way on
 *      every page, so a booking total does not appear as "145" on one screen
 *      and "USD 145.00" on another.
 *
 * COMMUNICATION
 * All components import from here.
 */

/** Returns the first element matching a selector, or null. */
export function getElement(selector, root = document) {
    return root.querySelector(selector);
}

/** Returns every element matching a selector as an array. */
export function getElements(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
}

/**
 * Escapes text for safe interpolation into an HTML string.
 *
 * Use this when building a large block of markup as a string. Prefer
 * textContent where possible; escapeHtml is for the cases where a template
 * string is genuinely the clearest approach.
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Builds an element from a tag, attributes and children.
 *
 * Children may be nodes or strings. Strings become text nodes, which is what
 * keeps user data out of the HTML parser.
 *
 * @param {string} tag
 * @param {object} [attributes] e.g. { class: 'card', 'data-id': 3 }
 * @param {Array<Node|string>} [children]
 */
export function createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);

    for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined || value === false) continue;

        if (key === 'class') {
            element.className = value;
        } else if (key === 'text') {
            element.textContent = value;
        } else if (key === 'html') {
            // Only for markup this project generates itself, never API data.
            element.innerHTML = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            element.setAttribute(key, String(value));
        }
    }

    for (const child of children) {
        if (child === null || child === undefined) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return element;
}

/** Removes every child of an element. */
export function clear(element) {
    if (element) element.textContent = '';
    return element;
}

/** Replaces an element's children with new content. */
export function render(element, children) {
    if (!element) return null;
    clear(element);
    for (const child of [].concat(children)) {
        if (child) element.append(child);
    }
    return element;
}

/**
 * Formats a date for display.
 *
 * Dates arrive from the API as 'YYYY-MM-DD' strings, which are deliberately
 * NOT parsed into a Date here: doing so would reinterpret a calendar date in
 * the browser's timezone and could shift it by a day.
 *
 * @param {string|Date} value
 * @param {string} [fallback='-'] Shown when the value is missing.
 */
export function formatDate(value, fallback = '-') {
    if (!value) return fallback;

    // Already a Date (for example a timestamp from created_at).
    if (value instanceof Date) {
        return value.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }

    const text = String(value);

    // 'YYYY-MM-DD' is displayed directly in a readable form.
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        const months = [
            'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
        ];
        const monthName = months[Number(month) - 1] || month;
        return `${Number(day)} ${monthName} ${year}`;
    }

    // A datetime string, with the time portion kept.
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    return text;
}

/** Formats a date as 'YYYY-MM-DD' for an <input type="date"> value. */
export function toDateInputValue(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Today's date as 'YYYY-MM-DD'. */
export function todayInputValue() {
    return toDateInputValue(new Date());
}

/** Adds days to a date and returns 'YYYY-MM-DD'. */
export function addDaysInputValue(days, from = new Date()) {
    const value = new Date(from);
    value.setDate(value.getDate() + days);
    return toDateInputValue(value);
}

/** Number of nights between two 'YYYY-MM-DD' strings. */
export function nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return 0;
    // Parse as UTC noon so a DST boundary cannot shorten or lengthen the count.
    const start = Date.parse(`${checkIn}T12:00:00Z`);
    const end = Date.parse(`${checkOut}T12:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end)) return 0;
    return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** Formats money, e.g. 145 -> 'USD 145.00'. */
export function formatMoney(amount, currency = 'USD') {
    const value = Number(amount);
    if (Number.isNaN(value)) return `${currency} 0.00`;
    return `${currency} ${value.toFixed(2)}`;
}

/** Formats a number with thousands separators. */
export function formatNumber(value) {
    const number = Number(value);
    if (Number.isNaN(number)) return '0';
    return number.toLocaleString();
}

/** Formats a rating as '4.5' from a numeric average. */
export function formatRating(value) {
    const number = Number(value);
    if (Number.isNaN(number)) return '0.0';
    return number.toFixed(1);
}

/**
 * Reads a query string parameter from the page URL.
 * Used for deep links such as /booking-details.html?id=42
 */
export function getQueryParam(name, search = window.location.search) {
    return new URLSearchParams(search).get(name);
}

/**
 * Debounces a function so it runs at most once per `wait` milliseconds.
 * Used for search inputs so typing does not fire a request per keystroke.
 */
export function debounce(fn, wait = 300) {
    let timeout;
    return function debounced(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

/**
 * Toggles busy state on a button: disables it and swaps the label, so a
 * double click cannot submit a form twice.
 */
export function setButtonLoading(button, isLoading, loadingText = 'Working...') {
    if (!button) return;

    if (isLoading) {
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>${loadingText}`;
        button.setAttribute('aria-busy', 'true');
    } else {
        button.disabled = false;
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }
        button.removeAttribute('aria-busy');
    }
}

/**
 * Renders a placeholder while content loads, so the layout does not jump when
 * the data arrives.
 */
export function showSkeleton(container, count = 3, height = 'h-24') {
    if (!container) return;
    clear(container);
    for (let i = 0; i < count; i += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = `skeleton ${height} mb-3`;
        skeleton.setAttribute('aria-hidden', 'true');
        container.appendChild(skeleton);
    }
    container.setAttribute('aria-busy', 'true');
}

/** Removes loading state and renders an empty state when there is no data. */
export function showEmptyState(container, { title, message, icon = 'fa-inbox', actionHtml = '' }) {
    if (!container) return;
    clear(container);
    container.removeAttribute('aria-busy');

    const wrapper = document.createElement('div');
    wrapper.className = 'text-center py-12 px-4';

    const iconEl = createElement('i', { class: `fa-solid ${icon} text-3xl text-stone-300 mb-4`, 'aria-hidden': 'true' });
    const titleEl = createElement('p', { class: 'font-semibold text-stone-900 mb-1', text: title });
    const messageEl = createElement('p', { class: 'text-sm text-stone-500', text: message });

    wrapper.append(iconEl, titleEl, messageEl);
    if (actionHtml) {
        // Only project-authored markup is passed here, never API data.
        const action = createElement('div', { class: 'mt-4', html: actionHtml });
        wrapper.appendChild(action);
    }
    container.appendChild(wrapper);
}

/** Human readable label for a status value, with a matching badge class. */
const STATUS_STYLES = {
    // Bookings
    pending: { label: 'Pending', badge: 'badge-warning' },
    confirmed: { label: 'Confirmed', badge: 'badge-success' },
    checked_in: { label: 'Checked In', badge: 'badge-info' },
    checked_out: { label: 'Checked Out', badge: 'badge-neutral' },
    cancelled: { label: 'Cancelled', badge: 'badge-danger' },
    // Rooms
    available: { label: 'Available', badge: 'badge-success' },
    occupied: { label: 'Occupied', badge: 'badge-info' },
    reserved: { label: 'Reserved', badge: 'badge-warning' },
    maintenance: { label: 'Maintenance', badge: 'badge-danger' },
    cleaning: { label: 'Cleaning', badge: 'badge-accent' },
    // Orders
    preparing: { label: 'Preparing', badge: 'badge-warning' },
    ready: { label: 'Ready', badge: 'badge-accent' },
    out_for_delivery: { label: 'Out For Delivery', badge: 'badge-info' },
    delivered: { label: 'Delivered', badge: 'badge-success' },
    // Payments
    completed: { label: 'Paid', badge: 'badge-success' },
    failed: { label: 'Failed', badge: 'badge-danger' },
    refunded: { label: 'Refunded', badge: 'badge-neutral' },
    processing: { label: 'Processing', badge: 'badge-warning' },
    // Invoices
    unpaid: { label: 'Unpaid', badge: 'badge-danger' },
    partially_paid: { label: 'Part Paid', badge: 'badge-warning' },
    paid: { label: 'Paid', badge: 'badge-success' },
    void: { label: 'Void', badge: 'badge-neutral' },
};

/**
 * Returns a complete badge element for a status.
 *
 * Uses a fixed lookup table rather than building a class name from the status,
 * because Tailwind cannot see dynamically generated class names and would
 * emit no rule for them.
 */
export function statusBadge(status) {
    const style = STATUS_STYLES[status] || { label: status || 'Unknown', badge: 'badge-neutral' };
    return createElement('span', { class: `badge ${style.badge}`, text: style.label });
}

/** Just the label for a status, for places that need plain text. */
export function statusLabel(status) {
    return (STATUS_STYLES[status] || {}).label || status || 'Unknown';
}