/**
 * public/js/lib/motion.js
 *
 * WHAT THIS MODULE DOES
 * Adds movement to the interface: elements fade and rise as they scroll into
 * view, groups of cards arrive one after another, and numbers count up to their
 * value.
 *
 * WHY THIS EXISTS
 * A page that renders every element at full opacity, all at once, reads as
 * finished before the user has looked at it. The eye has no chance to follow
 * what appeared. Entrance motion gives the page a sequence: the hero settles,
 * then the section below it, then each card in turn.
 *
 * The work is here rather than in the pages because the pages cannot see each
 * other. Most content on this site is rendered AFTER load, by cards.js, long
 * after the page script that could have animated it has finished. A MutationObserver
 * picks up those cards as they are inserted, so every list in the application
 * gets the same treatment without thirty page edits.
 *
 * WHY EVERY ANIMATION IS OPT-OUT IN PRACTICE
 * If this module fails to load, IntersectionObserver is missing, or the user
 * prefers reduced motion, everything is revealed at once and the page is simply
 * static. Nothing is ever left invisible, because a missing observer would
 * otherwise leave the content stuck at opacity 0.
 *
 * COMMUNICATION
 * app.js -> initMotion() -> starts observing
 * any renderer -> inserts [data-reveal] or [data-count] -> picked up automatically
 */

/**
 * Milliseconds between consecutive items in a staggered group.
 *
 * Small on purpose. A visible cascade needs enough separation to read as
 * sequence, but a dashboard that staggers forty table rows by 120ms each takes
 * five seconds to settle, which reads as lag rather than polish.
 */
const STAGGER_STEP = 45;

/** No group's cascade runs longer than this, however many items it holds. */
const STAGGER_CEILING = 450;

/**
 * Elements that animate in automatically because they are the main content
 * unit of a page: cards, and the rows of a data table.
 *
 * Table rows fade rather than rise. A row is a strip of a grid, and sliding
 * one up makes it visually detach from the rows beneath it.
 */
const AUTO_REVEAL_SELECTOR = '.card, .reveal-item, .table tbody tr';

const reduceMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

/**
 * Whether the user has asked for less movement.
 *
 * Read at the moment an animation would start rather than cached at load, so
 * toggling the system setting takes effect without a refresh.
 */
export function prefersReducedMotion() {
    return Boolean(reduceMotionQuery?.matches);
}

let observer = null;
let started = false;

/**
 * Reveals everything in a subtree immediately, cancelling any pending reveal.
 * Exported for the fallback path and for callers that build a section with
 * innerHTML after the fact.
 *
 * @param {ParentNode} [root=document]
 */
export function revealNow(root = document) {
    for (const element of root.querySelectorAll('[data-reveal]:not(.is-revealed)')) {
        reveal(element);
    }
}

/** Marks one element as arrived. */
function reveal(element) {
    element.classList.add('is-revealed');

    // The cascade delay is kept until the animation has played: clearing it
    // first would collapse the stagger, because the animation starts from the
    // class change and would then run with no delay at all.
    element.addEventListener(
        'animationend',
        () => element.style.removeProperty('--reveal-delay'),
        { once: true },
    );
}

/**
 * Sets the per-item delay that makes a group arrive in sequence.
 *
 * The step shrinks for large groups so the last item never waits more than
 * STAGGER_CEILING. Ten cards at 45ms is a 450ms cascade; forty cards at 11ms is
 * the same total time, so a long list settles as quickly as a short one.
 *
 * @param {ParentNode} items
 * @param {number} step
 */
function applyStagger(items, step = STAGGER_STEP) {
    const size = items.length;
    const effective = size > 1 ? Math.min(step, STAGGER_CEILING / size) : 0;

    items.forEach((item, index) => {
        // An explicit delay authored on the element wins: a page can override
        // the computed cascade where it needs to.
        if (item.dataset.revealDelay) return;
        item.style.setProperty('--reveal-delay', `${Math.round(index * effective)}ms`);
    });
}

/**
 * Starts observing a subtree for elements that should animate in.
 *
 * @param {ParentNode} [root=document]
 */
export function observe(root = document) {
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
        revealNow(root);
        return null;
    }

    if (!observer) {
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    // Only unobserve once it is on screen; an element scrolled
                    // past again should not replay its entrance.
                    reveal(entry.target);
                    observer.unobserve(entry.target);
                }
            },
            {
                // Fire slightly before the element's edge reaches the viewport,
                // so the movement is finished by the time it is properly in view.
                rootMargin: '0px 0px -10% 0px',
                threshold: 0.05,
            },
        );
    }

    watch(root);
    return observer;
}

/**
 * Finds reveal targets inside a subtree and registers them, grouping siblings so
 * they cascade.
 *
 * @param {ParentNode} root
 */
function watch(root) {
    // Whether an entrance animation can actually run for this subtree.
    //
    // observe() returns null and never builds an observer when the user prefers
    // reduced motion or IntersectionObserver is missing. This flag matters
    // because watch() is also called for content inserted AFTER initMotion
    // has already taken that early-return path: those elements still need
    // marking revealed, and asking a null observer to observe them would throw
    // and leave them stranded at opacity 0.
    const canAnimate = observer !== null && typeof IntersectionObserver !== 'undefined';

    const explicit = Array.from(root.querySelectorAll('[data-reveal]'));
    const automatic = explicit.length
        ? []
        : Array.from(root.querySelectorAll(AUTO_REVEAL_SELECTOR)).filter(
              // Only the outermost card of a subtree, or every nested card in a
              // list animates twice and the outer one drags the inner along.
              (element) => !element.parentElement?.closest(AUTO_REVEAL_SELECTOR),
          );

    const targets = (explicit.length ? explicit : automatic).filter(
        (element) => !element.classList.contains('is-revealed'),
    );

    // Cards arriving together cascade, so a grid of six reads as a sequence
    // rather than as six things appearing at once. Grouped by parent because
    // that is the row or column the eye reads left to right.
    const groups = new Map();
    for (const element of targets) {
        const key = element.parentElement;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(element);
    }
    for (const items of groups.values()) applyStagger(items);

    for (const element of targets) {
        // Cards and rows carry no motion markup of their own: app.css only
        // hides [data-reveal], so adding it here is what opts them in.
        if (!element.hasAttribute('data-reveal')) {
            element.setAttribute('data-reveal', element.matches('tbody tr') ? 'fade' : 'up');
        }

        // With no observer to register with, the element is revealed straight
        // away. Skipping this would leave it at the [data-reveal] opacity of 0
        // forever, which is the one failure this module promises never to have.
        if (!canAnimate) {
            reveal(element);
            continue;
        }

        // An element already on screen should not wait for a scroll to arrive,
        // so it is treated as if it had just intersected.
        const rect = element.getBoundingClientRect();
        const onScreen = rect.top < window.innerHeight && rect.bottom > 0;
        if (onScreen) {
            reveal(element);
            continue;
        }

        observer.observe(element);
    }

    // Anything explicitly marked as a group cascades its children.
    for (const group of root.querySelectorAll('[data-stagger]')) {
        applyStagger(Array.from(group.children));
    }
}

/**
 * Animates a group of elements that already exist, for a section built by hand
 * rather than inserted one card at a time.
 *
 * @param {Element|ParentNode} target Element, or a container whose children move.
 * @param {object} [options]
 * @param {number} [options.step]     Milliseconds between items.
 * @param {string}  [options.direction] 'up' for a rise, 'left' or 'right' for a
 *   slide, 'fade' for a plain fade.
 */
export function stagger(target, options = {}) {
    const { step = STAGGER_STEP, direction = 'up' } = options;

    const items =
        target instanceof Element && target.matches('[data-reveal], .reveal-item')
            ? [target]
            : Array.from(target.children);

    if (!items.length) return;

    items.forEach((item, index) => {
        item.setAttribute('data-reveal', direction);
        if (!prefersReducedMotion()) {
            item.style.setProperty('--reveal-delay', `${Math.round(index * step)}ms`);
        }
    });

    observe(target.parentNode || document);
}

/**
 * Counts a number up to its value once it is on screen.
 *
 * Used for the figures on the landing page, where a number that is already
 * there when the page loads gets read as part of the layout rather than as
 * information arriving. The final text is written unconditionally, so the value
 * is correct whether or not the animation runs.
 *
 * @param {Element} element Element whose text is a number. `data-count-to` gives
 *   the target; the element's own text is the starting point.
 * @param {object} [options]
 * @param {number} [options.duration=1100]
 */
export function countUp(element, { duration = 1100 } = {}) {
    const target = Number(element.dataset.countTo ?? element.textContent);
    const decimals = (element.dataset.countTo ?? element.textContent).includes('.')
        ? (element.dataset.countTo ?? element.textContent).split('.')[1].length
        : 0;

    if (!Number.isFinite(target) || target === 0) return;

    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
        element.textContent = formatCount(target, decimals);
        return;
    }

    const start = performance.now();

    const tick = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // Eased out, so the number races and then settles rather than crawling
        // to the end at a constant rate.
        const eased = 1 - Math.pow(1 - progress, 3);

        element.textContent = formatCount(target * eased, decimals);

        if (progress < 1) requestAnimationFrame(tick);
        else element.textContent = formatCount(target, decimals);
    };

    requestAnimationFrame(tick);
}

function formatCount(value, decimals) {
    return decimals ? value.toFixed(decimals) : Math.round(value).toLocaleString();
}

/**
 * Watches for content inserted after load and reveals it.
 *
 * Every list in the application is built from API data after the page script has
 * finished, so this is what makes cards animate as they arrive.
 */
function watchForInsertions() {
    if (typeof MutationObserver === 'undefined') return;

    const mutation = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                watch(node);
            }
        }
    });

    mutation.observe(document.body, { childList: true, subtree: true });
}

/**
 * Starts motion for the page. Safe to call more than once.
 *
 * @param {object} [options]
 * @param {ParentNode} [options.root=document] Subtree to watch.
 * @param {boolean} [options.watchFuture=true] Also reveal content inserted later.
 */
export function initMotion({ root = document, watchFuture = true } = {}) {
    if (started) return;
    started = true;

    observe(root);
    if (watchFuture) watchForInsertions();

    for (const element of document.querySelectorAll('[data-count]')) {
        runCount(element);
    }
}

/** Starts a count once, on first intersection. */
function runCount(element) {
    if (!prefersReducedMotion() && typeof IntersectionObserver !== 'undefined') {
        const countObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    countObserver.disconnect();
                    countUp(element);
                }
            },
            { threshold: 0.4 },
        );
        countObserver.observe(element);
        return;
    }

    countUp(element);
}

export default { initMotion, observe, revealNow, stagger, countUp, prefersReducedMotion };
