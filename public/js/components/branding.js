/**
 * public/js/components/branding.js
 *
 * WHAT THIS MODULE DOES
 * Loads the hotel's branding once per page and writes it into every place that
 * shows it: the header wordmark, the sidebar, the footer, the auth pages, the
 * page title and the logo badges.
 *
 * WHY THE MARKUP CARRIES data-brand ATTRIBUTES
 * The alternative is a list of hard coded ids, which breaks the moment a page
 * has two wordmarks or a third badge. Instead each element declares what it
 * is with `data-brand="name"`, and this module fills in whatever it finds.
 * Adding branding to a new page is then a one-attribute change, and a stale
 * hard coded name is impossible because there is none.
 *
 * WHY IT NEVER BLOCKS THE PAGE
 * The header is above the fold on every page. If the branding request failed,
 * or the settings table were missing, the page must still render. So the fetch
 * falls back to the shipped defaults, and even a total network failure leaves
 * the original markup in place: every default value matches what the HTML
 * already says.
 *
 * WHY THE FALLBACK NAME IS THE ONE IN THE MARKUP
 * `document.title` is fixed by replacing the default name, which is how the
 * static titles in the HTML get updated without each page rewriting its own
 * title after load.
 *
 * COMMUNICATION
 * Called by: js/app.js (every page with the shared furniture) and the auth
 *      pages, which have no header.
 *      -> GET /api/settings/branding
 *      -> GET /api/settings/logo (indirectly, through the returned URL)
 * Database tables used: none; all of this is served by the settings API.
 */

/** Must match what the HTML ships, since it is used to rewrite titles. */
const DEFAULT_BRANDING = Object.freeze({
    systemName: 'Aurelia Grand Hotel',
    tagline: 'Nairobi, Kenya',
    contactPhone: '+254 700 000 000',
    contactEmail: 'reservations@example.com',
    contactAddress: '24 Riverside Drive, Nairobi, Kenya',
    logoUrl: null,
});

/** The resolved branding, or null before the first load completes. */
let current = null;

/** The in-flight request, so several callers share one fetch. */
let pending = null;

/**
 * The name this module last put into document.title, so a second call can
 * replace that rather than the default the markup shipped with.
 */
let previousName = null;

/**
 * The branding, fetching it once per page.
 * @returns {Promise<object>}
 */
export async function getBranding() {
    if (current) return current;
    if (pending) return pending;

    pending = fetch('/api/settings/branding', { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
            // A response without the expected fields is treated as no response,
            // so a half-broken deployment keeps the markup's own defaults.
            current = payload?.data?.branding ? { ...DEFAULT_BRANDING, ...payload.data.branding } : { ...DEFAULT_BRANDING };
            return current;
        })
        .catch(() => {
            current = { ...DEFAULT_BRANDING };
            return current;
        })
        .finally(() => {
            pending = null;
        });

    return pending;
}

/** The current brand name, without waiting. Falls back to the default. */
export function brandName() {
    return current?.systemName || DEFAULT_BRANDING.systemName;
}

/**
 * Replaces the branding and rewrites the page, without a reload.
 * Used by the admin settings form after a successful save, so the change is
 * visible immediately rather than on the next page load.
 *
 * @param {object} branding As returned by the settings API.
 */
export function setBranding(branding) {
    current = { ...DEFAULT_BRANDING, ...branding };
    applyBranding(current);
    return current;
}

/**
 * Loads the branding and applies it to the page.
 * Call after the components or cards that show it are in the document.
 */
export async function initBranding() {
    const branding = await getBranding();
    applyBranding(branding);

    // Marks the document as branded. Tests and scripts that need to wait for
    // the name to be in the page have something to observe, rather than
    // guessing at a delay.
    document.documentElement.dataset.brandingReady = '1';

    return branding;
}

/**
 * Writes the branding into the document.
 * @param {object} branding
 * @param {ParentNode} [root=document] Narrow this to repaint one subtree.
 */
export function applyBranding(branding, root = document) {
    const values = { ...DEFAULT_BRANDING, ...branding };

    applyText(root, 'name', values.systemName);
    applyText(root, 'tagline', values.tagline);
    applyText(root, 'contactPhone', values.contactPhone);
    applyText(root, 'contactEmail', values.contactEmail);
    applyText(root, 'contactAddress', values.contactAddress);

    // Links carry a scheme that must match their new text, otherwise a stale
    // tel:+254... would survive a new phone number.
    applyLinks(root, values);

    applyOptionalRows(root, values);

    applyLogos(root, values);

    applyTitle(values.systemName);
}

/**
 * Fills in plain text slots.
 *
 * These elements hold text and nothing else, so assigning textContent is safe
 * and cannot destroy an icon a neighbouring element owns.
 */
function applyText(root, key, value) {
    for (const element of root.querySelectorAll(`[data-brand="${key}"]`)) {
        element.textContent = value || '';
    }
}

/**
 * Hides the optional rows when a value has been cleared.
 *
 * The rows carry a Tailwind `flex` class, which would beat the browser's
 * `[hidden] { display: none }` rule on specificity, so the display is set
 * directly instead. An admin who clears the phone number should not see a row
 * with an icon and nothing after it.
 */
function applyOptionalRows(root, values) {
    for (const row of root.querySelectorAll('[data-brand-contact]')) {
        row.style.display = values[row.dataset.brandContact] ? '' : 'none';
    }
}

function applyLinks(root, values) {
    for (const element of root.querySelectorAll('[data-brand-link="phone"]')) {
        if (!values.contactPhone) {
            // Removed rather than left pointing at the old number: the row is
            // hidden, but a stale tel: in the DOM is still a wrong answer to
            // "what is this link for".
            element.removeAttribute('href');
            continue;
        }
        element.setAttribute('href', `tel:${values.contactPhone.replace(/[^\d+]/g, '')}`);
    }
    for (const element of root.querySelectorAll('[data-brand-link="email"]')) {
        if (values.contactEmail) element.setAttribute('href', `mailto:${values.contactEmail}`);
        else element.removeAttribute('href');
    }
}

/**
 * Renders the logo into every badge.
 *
 * Each badge is an empty container that carries its own size and colour, so
 * this only has to decide what goes inside: an uploaded/linked image, or the
 * built-in hotel icon when nothing has been configured.
 */
function applyLogos(root, values) {
    for (const badge of root.querySelectorAll('[data-brand="logo"]')) {
        badge.textContent = '';

        if (values.logoUrl) {
            const image = document.createElement('img');
            image.src = values.logoUrl;
            image.alt = `${values.systemName} logo`;
            // The badge supplies the box; the image fills it.
            image.className = 'w-full h-full rounded-lg object-contain bg-white p-0.5';
            // A cached logo path can briefly 404 while a new upload is being
            // written, and a broken image icon is worse than the fallback.
            // The guard matters: this handler can fire long after the badge has
            // been repainted, and appending to it then would leave two marks.
            image.addEventListener(
                'error',
                () => {
                    if (badge.firstElementChild !== image) return;
                    badge.replaceChildren(iconFallback());
                },
                { once: true },
            );
            badge.appendChild(image);
        } else {
            badge.appendChild(iconFallback());
        }
    }
}

/** The default mark: the same amber badge with a hotel icon the markup had. */
function iconFallback() {
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-hotel';
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

/**
 * Rewrites the brand name in the page title.
 *
 * The HTML ships with the default name, so replacing that occurrence works
 * whether the brand leads the title ("Aurelia Grand Hotel | Rooms") or trails
 * it ("Sign in | Aurelia Grand Hotel"), without every page saying which.
 *
 * `previousName` is what makes a rename that happens while the page is open
 * work: by then the title already carries the old configured name, not the
 * default, so there is nothing left to match by default any more.
 */
function applyTitle(name) {
    if (!name) return;

    const title = document.title;
    const from = previousName || DEFAULT_BRANDING.systemName;

    if (title.includes(from)) {
        document.title = title.replace(from, name);
    } else if (!title.endsWith(name)) {
        // Nothing recognisable to replace, which happens on a page that sets
        // its title at runtime. Appending keeps the brand visible.
        document.title = `${title} | ${name}`;
    }

    previousName = name;
}

export { DEFAULT_BRANDING };
export default { initBranding, getBranding, brandName, setBranding, applyBranding };
