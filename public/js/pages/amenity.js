/**
 * public/js/pages/amenity.js
 *
 * WHAT THIS MODULE DOES
 * Renders the detail page for one hotel amenity, reached from a card on the
 * landing page as /pages/amenity.html?amenity=rooftop-terrace.
 *
 * WHY THIS IS ONE PAGE RATHER THAN ONE PAGE PER AMENITY
 * Every amenity page has the same shape: a photograph, a summary, some facts,
 * highlights, and links to related amenities. Only the copy changes. Rendering
 * that from the shared module in js/data/amenities.js means an amenity is added
 * in one place and cannot drift between the card that links here and the page
 * it opens. The alternative, a hand-written file per amenity, would repeat the
 * same markup twelve times.
 *
 * WHY IT IS PUBLIC AND USES initApp INSTEAD OF buildShell
 * Guests research a hotel before they decide to book, so this must be readable
 * without an account. buildShell is the dashboard layout with a sidebar and an
 * auth guard, which is the wrong shape for a marketing page. initApp still
 * loads the header and footer, and still starts motion.
 *
 * WHAT HAPPENS WITH A BAD SLUG
 * A missing or unknown ?amenity= renders a not-found state with a link back to
 * the amenities section, rather than throwing or leaving a blank page. The page
 * is reachable by typing the URL, so the failure is reachable too.
 *
 * COMMUNICATION
 * js/data/amenities.js  -> the content, and amenityPageUrl() for links
 * public/index.html     -> sends the visitor here with ?amenity=<slug>
 */
import { initApp } from '../app.js';
import { createElement, getQueryParam } from '../lib/dom.js';
import { getAmenity, amenityPageUrl, relatedAmenities } from '../data/amenities.js';

// Loads the header and footer, and starts the reveal/count animations. No
// sidebar: this is a public page, not a dashboard.
await initApp({ footer: true, sidebar: false });

const main = document.getElementById('page-content');
const slug = getQueryParam('amenity');
const amenity = getAmenity(slug);

/** A labelled fact from the short label/value pairs. */
function factItem({ label, value }) {
    return createElement('div', { class: 'bg-stone-50 rounded-lg p-4' }, [
        createElement('dt', {
            class: 'text-xs uppercase tracking-wide text-stone-500 mb-1',
            text: label,
        }),
        createElement('dd', { class: 'font-semibold text-stone-900', text: value }),
    ]);
}

/** A bullet in the highlights list, with the check icon used across the site. */
function highlightItem(text) {
    return createElement('li', { class: 'flex items-start gap-2.5' }, [
        createElement('i', {
            class: 'fa-solid fa-check text-green-600 mt-1',
            'aria-hidden': 'true',
        }),
        createElement('span', { text }),
    ]);
}

/**
 * A compact card for one amenity, used in the "explore next" strip.
 * Wraps the whole card in one link so the click target is the card, not just
 * the heading.
 */
function relatedCard(item) {
    const card = createElement(
        'a',
        {
            href: amenityPageUrl(item.slug),
            class: 'card card-hover p-5 flex items-start gap-4',
        },
        [
            createElement('span', {
                class: 'flex items-center justify-center w-11 h-11 rounded-lg bg-amber-100 text-amber-700 shrink-0',
            }, [
                createElement('i', { class: `fa-solid ${item.icon}`, 'aria-hidden': 'true' }),
            ]),
            createElement('span', { class: 'min-w-0' }, [
                createElement('span', {
                    class: 'block font-semibold text-stone-900 mb-1',
                    text: item.name,
                }),
                createElement('span', {
                    class: 'block text-sm text-stone-500 leading-relaxed',
                    text: item.tagline,
                }),
            ]),
        ],
    );

    return card;
}

/** Shown for a missing or unknown ?amenity=. */
function renderNotFound() {
    document.title = 'Amenity not found | Aurelia Grand Hotel';

    main.append(
        createElement('div', { class: 'max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center' }, [
            createElement('span', {
                class: 'inline-flex items-center justify-center w-14 h-14 rounded-full bg-stone-100 text-stone-400 mb-5',
            }, [
                createElement('i', { class: 'fa-solid fa-compass text-2xl', 'aria-hidden': 'true' }),
            ]),
            createElement('h1', {
                class: 'text-2xl font-bold text-stone-900 mb-2',
                text: 'We could not find that amenity',
            }),
            createElement('p', {
                class: 'text-stone-500 mb-8',
                text: 'The link may be out of date. Every facility we offer is listed on the home page.',
            }),
            createElement('a', {
                href: '/#amenities',
                class: 'btn btn-primary',
                text: 'Browse all amenities',
            }),
        ]),
    );
}

/** The full page for one amenity. */
function renderAmenity(item) {
    document.title = `${item.name} | Aurelia Grand Hotel`;

    // The description on the landing page card is deliberately short, so a
    // dedicated one is set per amenity rather than reusing the tagline.
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', item.summary.slice(0, 155));

    const heroCaption = [
        // Breadcrumb: where this page sits, for anyone arriving deep.
        createElement('nav', { class: 'mb-3', 'aria-label': 'Breadcrumb' }, [
            createElement('ol', { class: 'flex items-center gap-2 text-sm text-stone-300' }, [
                createElement('li', {}, [createElement('a', { href: '/', text: 'Home' })]),
                createElement('li', { 'aria-hidden': 'true', text: '/' }),
                createElement('li', {}, [
                    createElement('a', { href: '/#amenities', text: 'Amenities' }),
                ]),
            ]),
        ]),
        createElement('h1', {
            class: 'text-3xl sm:text-4xl font-bold',
            text: item.name,
        }),
    ];

    const caption = createElement(
        'div',
        { class: 'absolute inset-x-0 bottom-0 max-w-5xl mx-auto px-4 sm:px-6 pb-8 text-white' },
        heroCaption,
    );

    // ---- Hero ----
    // An amenity with no matching photograph gets a typographic hero rather
    // than an unrelated picture. Several files under gallery/ do not show what
    // their names claim, so showing one of those would be worse than showing
    // nothing.
    if (item.image) {
        main.append(
            createElement('section', { class: 'relative bg-stone-900' }, [
                createElement('img', {
                    src: item.image,
                    alt: item.imageAlt,
                    class: 'w-full h-64 sm:h-80 lg:h-96 object-cover animate-fade',
                    // The hero is above the fold, so eager avoids a visible pop.
                    loading: 'eager',
                }),
                createElement('div', {
                    class: 'absolute inset-0 bg-gradient-to-t from-stone-900 via-stone-900/40 to-transparent',
                }),
                caption,
            ]),
        );
    } else {
        main.append(
            createElement('section', { class: 'relative bg-stone-900 overflow-hidden' }, [
                // The gradient is a normal, in-flow block rather than an
                // absolutely positioned layer: an absolute child does not give
                // the section any height, and the caption then collapses and
                // renders as dark text on the dark background.
                createElement('div', {
                    class: 'absolute inset-0 bg-gradient-to-br from-stone-900 via-stone-800 to-stone-900',
                }),
                // A large ghosted icon fills the space a photograph would have.
                // Decorative, so it is hidden from assistive technology.
                createElement('i', {
                    class: `fa-solid ${item.icon} absolute -right-6 -bottom-10 text-[160px] sm:text-[220px] text-white/5 select-none pointer-events-none`,
                    'aria-hidden': 'true',
                }),
                createElement(
                    'div',
                    { class: 'relative h-64 sm:h-80 lg:h-96 flex flex-col justify-end' },
                    // Padding is on this element: the caption wrapper is
                    // absolutely positioned inside the hero for the photograph
                    // variant, and reusing that wrapper here dropped the
                    // horizontal inset entirely.
                    [
                        createElement(
                            'div',
                            { class: 'max-w-5xl mx-auto px-4 sm:px-6 pb-8 text-white' },
                            heroCaption,
                        ),
                    ],
                ),
            ]),
        );
    }

    // ---- Body: summary on one side, facts on the other ----
    const details = [
        createElement('div', {}, [
            createElement('h2', {
                class: 'text-xl font-semibold text-stone-900 mb-3',
                text: 'What to expect',
            }),
            createElement('p', {
                class: 'text-stone-600 leading-relaxed',
                text: item.summary,
            }),
        ]),
    ];

    const highlights = createElement('section', { class: 'mt-8' }, [
        createElement('h2', {
            class: 'text-xl font-semibold text-stone-900 mb-4',
            text: 'Good to know',
        }),
        createElement(
            'ul',
            { class: 'space-y-2.5 text-stone-600' },
            item.highlights.map(highlightItem),
        ),
    ]);
    details.push(highlights);

    // Facts. `location` and `hours` are always shown; hours is omitted for an
    // amenity that has no set hours, rather than shown as a blank row.
    const facts = [
        { label: 'Where', value: item.location },
        ...(item.hours ? [{ label: 'Hours', value: item.hours }] : []),
        ...item.facts,
    ];

    main.append(
        createElement('section', { class: 'max-w-5xl mx-auto px-4 sm:px-6 py-12' }, [
            createElement(
                'div',
                { class: 'grid gap-10 lg:grid-cols-3 items-start' },
                [
                    createElement('div', { class: 'lg:col-span-2 space-y-8' }, details),
                    createElement('aside', {}, [
                        createElement('div', { class: 'card p-5' }, [
                            createElement('h2', {
                                class: 'font-semibold text-stone-900 mb-4',
                                text: 'At a glance',
                            }),
                            createElement(
                                'dl',
                                { class: 'space-y-3' },
                                facts.map(factItem),
                            ),
                        ]),
                        createElement('a', {
                            href: '/pages/guest/rooms.html',
                            class: 'btn btn-primary btn-block mt-4',
                            text: 'Check availability',
                        }),
                    ]),
                ],
            ),
        ]),
    );

    // ---- Explore next ----
    const related = relatedAmenities(item.slug);
    if (related.length) {
        main.append(
            createElement('section', { class: 'max-w-5xl mx-auto px-4 sm:px-6 pb-4' }, [
                createElement('h2', {
                    class: 'text-xl font-semibold text-stone-900 mb-5',
                    text: 'Also in the hotel',
                }),
                createElement(
                    'div',
                    // data-stagger rather than data-reveal: the cards cascade in
                    // but are never left at opacity 0 if motion.js fails.
                    { class: 'grid gap-4 sm:grid-cols-2', 'data-stagger': '' },
                    related.map(relatedCard),
                ),
            ]),
        );
    }
}

if (amenity) {
    renderAmenity(amenity);
} else {
    renderNotFound();
}