/**
 * public/js/data/amenities.js
 *
 * WHAT THIS MODULE DOES
 * Holds the content for every hotel amenity: the rooftop terrace, the fitness
 * room, the restaurant and the rest. Each entry carries the copy used by both
 * the summary card on the landing page and the full detail page.
 *
 * WHY THIS IS A DATA MODULE AND NOT ONE HTML PAGE PER AMENITY
 * The landing page needs a card for every amenity, and every amenity also needs
 * a page of its own. Written as separate hand-authored pages, the one-line
 * summary and the long description would be duplicated, and adding an amenity
 * would mean editing a page, the card grid, and the navigation. Keeping the copy
 * here means an amenity is added in exactly one place.
 *
 * This follows the same pattern as pages/guest/room-details.js, which reads a
 * single `?id=` and renders one record. There the records come from the
 * database; here they are static marketing copy, so a module is the right home
 * for them.
 *
 * WHY IT IS NOT IN THE amenities TABLE
 * The database table holds in-room equipment (air conditioning, safe, minibar)
 * that varies per room and is attached to bookings. These are hotel-wide
 * facilities with editorial copy, images and opening hours, which is a
 * different shape of data.
 *
 * IMAGES
 * Every `image` points at a file that is committed under public/assets. A
 * detail page for an amenity whose photograph is missing would show a broken
 * image, so `image` is verified by scripts/check-pages.mjs and by
 * `node scripts/check-amenities.mjs`.
 *
 * COMMUNICATION
 * public/index.html            -> AMENITIES, summary cards
 * public/js/pages/amenity.js  -> AMENITIES, full detail page
 *                               -> amenityPageUrl(slug) for links
 */

/**
 * Every amenity offered by the hotel.
 *
 * Fields:
 *   slug        URL segment. Stable: it is what links point at, so changing
 *               one breaks bookmarks. Lowercase and hyphenated.
 *   name        Card and page heading.
 *   icon        Font Awesome class, e.g. 'fa-martini-glass'. Complete literal,
 *               because Tailwind CDN cannot see interpolated names.
 *   tagline     One line, used on the card.
 *   summary     Two or three sentences for the top of the detail page.
 *   image       Path to the photograph. Must exist under public/assets.
 *   imageAlt    Describes the photograph for a screen reader. Required: a
 *               decorative image with no alt text is read out as a filename.
 *   hours       Opening hours, shown as a fact. null when it is always open.
 *   location    Where in the building to find it.
 *   highlights  Bullet points describing what is actually there.
 *   facts       Short label/value pairs, e.g. capacity or size.
 *   related     Slugs of other amenities worth linking from this page, so a
 *               visitor at the end of one page has somewhere to go next.
 */
export const AMENITIES = [
    {
        slug: 'rooftop-terrace',
        name: 'Rooftop terrace',
        icon: 'fa-martini-glass',
        tagline: 'Open from six, with a view across the skyline',
        summary:
            'The terrace runs the length of the top floor and looks back toward the skyline over the river. It is where the hotel serves evening drinks, and where guests come up to watch the sun go down over the water.',
        // NOTE on images: the filenames under gallery/ were written before the
        // photographs were chosen and several no longer describe their contents
        // (rooftop.jpg is a pool at night, rooftop-bar.jpg is a guest room).
        // Each entry below was checked against the actual file, and the alt text
        // describes what is really in the picture rather than repeating a
        // misleading filename. `image` may be null where nothing suitable
        // exists; the page then renders a typographic hero instead of a
        // misleading photograph.
        image: '/assets/images/gallery/rooftop.jpg',
        imageAlt: 'A terrace bar lit against the evening sky, seen over a still reflecting pool',
        hours: 'Daily, 6:00pm to 11:00pm',
        location: 'Fifth floor, reached by the lift or the last flight of stairs',
        highlights: [
            'Evening drinks and a short list of wines from the cellar',
            'Low tables and shaded seating along the parapet',
            'The best view of the sunset over the river, roughly 6:15pm in June',
            'Blankets and a heat lamp kept out for the cooler months',
        ],
        facts: [
            { label: 'Capacity', value: '40 seated' },
            { label: 'Dress', value: 'Smart casual' },
        ],
        related: ['restaurant', 'fitness-room', 'pool'],
    },
    {
        slug: 'restaurant',
        name: 'Seasonal restaurant',
        icon: 'fa-utensils',
        tagline: 'Breakfast, lunch and dinner, plus room service',
        summary:
            'The kitchen follows the season rather than a fixed menu, working with four growers within a day of Nairobi. That means the card is rewritten most weeks, and the breakfast buffet changes through the year instead of repeating.',
        image: '/assets/images/site/restaurant.jpg',
        imageAlt: 'A plated dish being set down at a table in the restaurant',
        hours: 'Breakfast 6:00am, dinner until 10:00pm',
        location: 'Ground floor, opening onto the courtyard',
        highlights: [
            'Breakfast from six, with a full continental and a cooked counter',
            'A short lunch menu for business guests, weekdays only',
            'Room service from the same menu, delivered within forty minutes',
            'Vegetarian, vegan and gluten-free dishes marked on the card',
        ],
        facts: [
            { label: 'Seats', value: '60' },
            { label: 'Reservation', value: 'Recommended for dinner' },
        ],
        related: ['rooftop-terrace', 'function-rooms', 'laundry'],
    },
    {
        slug: 'fitness-room',
        name: 'Fitness room',
        icon: 'fa-dumbbell',
        tagline: 'Cardio and free weights, open from five',
        summary:
            'A compact gym on the second floor with cardio machines, free weights and a mat area. It is small rather than sprawling, which suits a city hotel: everything is close to hand and it is never busy.',
        // No photograph of the gym exists in the project, so the page falls back
        // to a typographic hero rather than showing an unrelated room.
        image: null,
        imageAlt: null,
        hours: 'Daily, 5:00am to 11:00pm',
        location: 'Second floor, opposite the lift',
        highlights: [
            'Treadmills, upright and recumbent bikes, and a rowing machine',
            'Free weights up to 25kg, with racks and a mirrored wall',
            'Towels and water available, and a mat area for stretching',
            'Towels are available from reception if you would rather not carry them',
        ],
        facts: [
            { label: 'Equipment', value: 'Cardio and free weights' },
            { label: 'Towels', value: 'Provided' },
        ],
        related: ['pool', 'sauna', 'laundry'],
    },
    {
        slug: 'pool',
        name: 'Pool terrace',
        icon: 'fa-water',
        tagline: 'Heated, with a sun deck along the river side',
        summary:
            'The pool sits on a sun deck along the south face of the building, screened from the road by planting. It is heated through the cool season and shaded by an awning at the hottest hours of the afternoon.',
        image: '/assets/images/gallery/pool-terrace.jpg',
        imageAlt: 'The pool deck at sunset, with palms, loungers and parasols around the water',
        hours: 'Daily, 7:00am to 9:00pm',
        location: 'Ground floor, south side',
        highlights: [
            'Heated to 28 degrees through the cool season',
            'Sun deck with loungers and parasols',
            'Shaded by an awning between two and five in the afternoon',
            'A shallow end for children, separated by a rail',
        ],
        facts: [
            { label: 'Size', value: '15m x 8m' },
            { label: 'Depth', value: '1.2m to 2m' },
        ],
        related: ['fitness-room', 'sauna', 'rooftop-terrace'],
    },
    {
        slug: 'sauna',
        name: 'Sauna and steam room',
        icon: 'fa-hot-tub-person',
        tagline: 'Wooden sauna beside the pool, booking recommended',
        summary:
            'A small wooden sauna with a steam room next to it, opening onto the pool deck. The two are booked together because the room is only used by one party at a time.',
        image: '/assets/images/gallery/pool-terrace.jpg',
        imageAlt: 'The pool deck the sauna opens onto, with loungers and parasols',
        hours: 'Daily, 8:00am to 9:00pm',
        location: 'Pool deck, ground floor',
        highlights: [
            'Wooden sauna benched for four, with a stove',
            'Steam room adjoining it',
            'Towels, water and a changing room included',
            'Booked in ninety minute slots so the room is never shared',
        ],
        facts: [
            { label: 'Capacity', value: '4 people' },
            { label: 'Slot', value: '90 minutes' },
        ],
        related: ['pool', 'fitness-room', 'laundry'],
    },
    {
        slug: 'reception',
        name: '24 hour reception',
        icon: 'fa-concierge-bell',
        tagline: 'Staffed around the clock for arrivals and requests',
        summary:
            'Reception is staffed through the night, so an early arrival or a late flight is never a problem. The team is small enough that most of them have been at the hotel a decade.',
        // reception.jpg is in fact a bedroom, so it is not used here.
        image: null,
        imageAlt: null,
        hours: 'Open 24 hours',
        location: 'Ground floor, main entrance',
        highlights: [
            'Staffed around the clock for arrivals, check-out and requests',
            'Luggage held before check-in and after check-out',
            'Wake-up calls and a same-day laundry service',
            'Parking, transfers and restaurant bookings arranged at the desk',
        ],
        facts: [
            { label: 'Languages', value: 'English, Swahili, French' },
            { label: 'Checkout', value: '11:00am' },
        ],
        related: ['parking', 'laundry', 'restaurant'],
    },
    {
        slug: 'parking',
        name: 'Secure parking',
        icon: 'fa-car',
        tagline: 'Covered parking on site, with valet on request',
        summary:
            'Parking is on site under cover, with space for thirty cars. Valet is available at any hour, and the gate is closed between midnight and five.',
        image: null,
        imageAlt: null,
        hours: 'Open 24 hours',
        location: 'Lower level, reached from the front drive',
        highlights: [
            'Thirty covered spaces on site, no street parking needed',
            'Valet available at any hour',
            'Gated and lit overnight, with an attendant from six to midnight',
            'Charging point for electric vehicles',
        ],
        facts: [
            { label: 'Spaces', value: '30' },
            { label: 'Cost', value: 'Complimentary for guests' },
        ],
        related: ['reception', 'function-rooms', 'rooftop-terrace'],
    },
    {
        slug: 'laundry',
        name: 'Laundry service',
        icon: 'fa-shirt',
        tagline: 'Same day turnaround before 10am',
        summary:
            'Laundry is collected from your room each morning and returned the same evening. Items left before ten are back by six that day, which is long enough to pack for the morning.',
        image: null,
        imageAlt: null,
        hours: 'Collection 8:00am to 12:00pm',
        location: 'Collected from your room',
        highlights: [
            'Collected from the room each morning, returned the same evening',
            'Items left before 10am are back by 6pm',
            'Pressing and dry cleaning, at an extra charge',
            'Express same-day service available on request',
        ],
        facts: [
            { label: 'Turnaround', value: 'Same day' },
            { label: 'Collection', value: 'Before 10:00am' },
        ],
        related: ['reception', 'restaurant', 'sauna'],
    },
    {
        slug: 'function-rooms',
        name: 'Function rooms',
        icon: 'fa-champagne-glasses',
        tagline: 'Two rooms for up to eighty seated guests',
        summary:
            'Two function rooms off the courtyard, one seating eighty and one seating thirty. They are used for weddings, workshops and company dinners, and the restaurant caters both.',
        // lobby.jpg is the exterior at dusk, which does not show a function
        // room, so this one falls back to a typographic hero.
        image: null,
        imageAlt: null,
        hours: 'By arrangement',
        location: 'Ground floor, opening onto the courtyard',
        highlights: [
            'Two rooms, seating eighty and thirty',
            'Both open onto the courtyard for arrivals in bad weather',
            'The restaurant caters for both, or you can use your own',
            'AV, staging and a lectern available in the larger room',
        ],
        facts: [
            { label: 'Largest', value: '80 seated' },
            { label: 'Layouts', value: 'Theatre, cabaret, banquet' },
        ],
        related: ['restaurant', 'parking', 'rooftop-terrace'],
    },
    {
        slug: 'wifi',
        name: 'WiFi throughout',
        icon: 'fa-wifi',
        tagline: 'Fibre in every room and public space',
        summary:
            'Fibre broadband reaches every room and all public spaces, including the courtyard and the pool deck. There is no charge and no time limit, and the network does not require a code.',
        image: null,
        imageAlt: null,
        hours: null,
        location: 'Everywhere in the hotel',
        highlights: [
            'Fibre broadband, no charge and no time limit',
            'Reaches the courtyard, the pool deck and the rooftop terrace',
            'No code to enter, so there is nothing to ask at the desk',
            'A wired connection is available at the desk in each room',
        ],
        facts: [
            { label: 'Cost', value: 'Complimentary' },
            { label: 'Coverage', value: 'All rooms and public areas' },
        ],
        related: ['reception', 'business-lounge', 'pool'],
    },
    {
        slug: 'business-lounge',
        name: 'Executive lounge',
        icon: 'fa-briefcase',
        tagline: 'Quiet work space, with coffee from seven',
        summary:
            'A small lounge on the fourth floor for guests who need somewhere to work away from the room. It has desks, a printer, and coffee from seven in the morning.',
        image: null,
        imageAlt: null,
        hours: 'Daily, 7:00am to 10:00pm',
        location: 'Fourth floor, beside the lift',
        highlights: [
            'Desks with power at every seat, and a printer',
            'Coffee, tea and water included',
            'A quiet room, with a separate area for calls',
            'Free for guests in Executive rooms and Suites',
        ],
        facts: [
            { label: 'Seats', value: '16' },
            { label: 'Access', value: 'Executive and Suite guests' },
        ],
        related: ['wifi', 'restaurant', 'parking'],
    },
];

/** The amenity with this slug, or null. */
export function getAmenity(slug) {
    if (!slug) return null;
    return AMENITIES.find((amenity) => amenity.slug === slug) || null;
}

/**
 * The path to one amenity's detail page.
 *
 * Built here rather than written into each link so the URL shape is defined in
 * one place: the detail page reads `?amenity=`, and this writes it.
 */
export function amenityPageUrl(slug) {
    return `/pages/amenity.html?amenity=${encodeURIComponent(slug)}`;
}

/**
 * Amenities for the "explore next" strip at the foot of a detail page.
 * Slugs that do not resolve are dropped rather than rendered as dead links.
 */
export function relatedAmenities(slug) {
    const current = getAmenity(slug);
    if (!current) return [];
    return current.related.map(getAmenity).filter(Boolean);
}

export default { AMENITIES, getAmenity, amenityPageUrl, relatedAmenities };