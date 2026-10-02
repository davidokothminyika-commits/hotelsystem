/**
 * public/js/components/loader.js
 *
 * WHAT THIS MODULE DOES
 * Loads reusable HTML fragments (header, sidebar, footer, cards, modals) into
 * a page at runtime.
 *
 * WHY THIS EXISTS
 * Without it, every page would contain its own copy of the header and
 * sidebar markup. Changing the navigation would then mean editing every page,
 * and the copies would inevitably drift apart. Fetching a single shared file
 * makes the header one source of truth.
 *
 * ---------------------------------------------------------------------------
 * ROOT-RELATIVE PATHS: WHY THEY MATTER HERE
 * ---------------------------------------------------------------------------
 * A URL always begins with '/', which the browser resolves against the
 * ORIGIN, not against the current page. Comparing, with pages at different
 * depths:
 *
 *   Page:  /pages/admin/users.html
 *
 *   '/components/header.html'   -> http://localhost:5000/components/header.html
 *                                  Always correct. Independent of page depth.
 *
 *   'components/header.html'    -> http://localhost:5000/pages/admin/components/header.html
 *                                  Resolved relative to the current directory.
 *                                  BREAKS on any page outside /pages/admin.
 *
 *   '../components/header.html' -> http://localhost:5000/pages/components/header.html
 *                                  Works only from exactly one directory depth.
 *                                  BREAKS as soon as pages are nested deeper or
 *                                  shallower than the author assumed.
 *
 * Every path in this project is therefore root-relative and begins with '/'.
 * That is the only form that is correct for a component used on pages at
 * different depths, which is the entire point of having shared components.
 *
 * ---------------------------------------------------------------------------
 * WHY LOADING IS DONE WITH TEMPLATES
 * ---------------------------------------------------------------------------
 * The plain approach works:
 *
 *   document.querySelector('#header').innerHTML =
 *       await (await fetch('/components/header.html')).text();
 *
 * That is fine, but it replaces the container's content and loses any event
 * listeners already attached to it, and it has no loading or error state. The
 * helpers below add those without hiding how it works.
 *
 * COMMUNICATION
 * Any page -> loadComponent('#app-header', '/components/header.html')
 */

/** Cache of fetched fragments, so navigating between pages is not re-fetched. */
const cache = new Map();

/**
 * Loads a component into a container.
 *
 * @param {string} selector CSS selector for the container.
 * @param {string} file     Root-relative path, e.g. '/components/header.html'.
 * @param {object} [options]
 * @param {boolean} [options.cache=true]
 * @returns {Promise<Element|null>} The container, or null if it is missing.
 */
export async function loadComponent(selector, file, options = {}) {
    const { cache: useCache = true } = options;

    const container = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!container) {
        console.warn(`[components] Container "${selector}" was not found, cannot load ${file}`);
        return null;
    }

    try {
        let html = useCache ? cache.get(file) : null;

        if (html === undefined || html === null) {
            const response = await fetch(file, { headers: { Accept: 'text/html' } });

            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }

            html = await response.text();
            if (useCache) cache.set(file, html);
        }

        container.innerHTML = html;

        // Notify listeners that this component is ready, so page scripts can
        // wire up behaviour that depends on its contents.
        container.dispatchEvent(new CustomEvent('component:loaded', { detail: { file } }));

        return container;
    } catch (error) {
        console.error(`[components] Failed to load ${file}:`, error.message);
        // A visible fallback is better than a silently empty region.
        container.innerHTML = `
            <div class="p-4 bg-red-50 text-red-700 text-sm rounded-lg" role="alert">
                This section could not be loaded. Please refresh the page.
            </div>`;
        return container;
    }
}

/**
 * Loads several components in parallel.
 *
 * Running them concurrently matters on a dashboard page that needs a header,
 * a sidebar and a notification region: three sequential fetches would show
 * the page in three stages instead of all at once.
 *
 * @param {Array<{selector: string, file: string}>} components
 */
export async function loadComponents(components) {
    return Promise.all(
        components.map(({ selector, file }) => loadComponent(selector, file)),
    );
}

/**
 * Loads a component and runs a setup function against it.
 * Keeps "fetch then wire up" as one operation at the call site.
 *
 * @param {string} selector
 * @param {string} file
 * @param {(container: Element, file: string) => void|Promise<void>} setup
 */
export async function withComponent(selector, file, setup) {
    const container = await loadComponent(selector, file);
    if (container) await setup(container, file);
    return container;
}

/** Clears the fragment cache. Useful after a hot reload during development. */
export function clearComponentCache() {
    cache.clear();
}

/**
 * Fetches a component fragment without inserting it, for cases where the
 * caller needs the markup to pass somewhere else (for example building a
 * PDF or an email preview).
 */
export async function fetchComponent(file) {
    if (cache.has(file)) return cache.get(file);

    const response = await fetch(file);
    if (!response.ok) throw new Error(`Failed to fetch ${file}`);

    const html = await response.text();
    cache.set(file, html);
    return html;
}

export default { loadComponent, loadComponents, withComponent, clearComponentCache, fetchComponent };