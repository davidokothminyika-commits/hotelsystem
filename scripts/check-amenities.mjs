/**
 * scripts/check-amenities.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Validates the amenity data used by the landing page grid and the detail
 * page: that every slug is unique, every referenced image exists on disk, every
 * `related` slug resolves, and every amenity has the copy a page needs.
 *
 * WHY IT EXISTS
 * The amenity pages are built at runtime from js/data/amenities.js, so nothing
 * else in the project would notice a typo in a slug or a photograph that was
 * renamed. A dead `related` link is invisible in the source: the array holds a
 * string, and nothing resolves it until a visitor clicks it.
 *
 * WHY IT RUNS WITHOUT A DATABASE
 * These pages are public marketing pages with static copy. The check needs no
 * server, no browser and no MySQL connection, so it stays fast enough to run on
 * every save.
 *
 * RUN
 *   node scripts/check-amenities.mjs
 *
 * COMMUNICATION
 * Reads:  public/js/data/amenities.js
 * Checks: the filesystem, for every referenced image path
 * Writes: nothing. Exits non-zero when anything fails.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const { AMENITIES, getAmenity } = await import(
    pathToFileURL(path.join(PUBLIC_DIR, 'js/data/amenities.js')).href
);

const errors = [];

/** Fields a detail page cannot render without. */
const REQUIRED_STRINGS = ['slug', 'name', 'icon', 'tagline', 'summary', 'location'];

const seenSlugs = new Map();

for (const amenity of AMENITIES) {
    const where = amenity.name || amenity.slug || '(unnamed entry)';

    for (const field of REQUIRED_STRINGS) {
        const value = amenity[field];
        if (typeof value !== 'string' || !value.trim()) {
            errors.push(`${where}: "${field}" is missing or empty`);
        }
    }

    // A slug is put in a URL, so it must be safe and match what links assume.
    if (amenity.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(amenity.slug)) {
        errors.push(`${where}: slug "${amenity.slug}" must be lowercase and hyphenated`);
    }

    if (amenity.slug) {
        if (seenSlugs.has(amenity.slug)) {
            errors.push(`${where}: slug "${amenity.slug}" is duplicated`);
        }
        seenSlugs.set(amenity.slug, amenity.name);
    }

    // `image` may be null, in which case the page renders a typographic hero.
    // But it and `imageAlt` must agree: a photograph with no alt text is read
    // out as a bare file name, which is worse than no photograph at all.
    if (amenity.image) {
        const imagePath = path.join(PUBLIC_DIR, amenity.image.replace(/^\//, ''));
        if (!existsSync(imagePath)) {
            errors.push(`${where}: image not found at ${amenity.image}`);
        }
        if (typeof amenity.imageAlt !== 'string' || !amenity.imageAlt.trim()) {
            errors.push(`${where}: has an image but no imageAlt`);
        }
    } else if (amenity.imageAlt) {
        errors.push(`${where}: has an imageAlt but no image`);
    }

    if (!Array.isArray(amenity.highlights) || amenity.highlights.length === 0) {
        errors.push(`${where}: "highlights" must be a non-empty array`);
    }

    if (!Array.isArray(amenity.facts)) {
        errors.push(`${where}: "facts" must be an array`);
    }

    // A related slug that does not resolve would render a 404 for the guest.
    for (const relatedSlug of amenity.related || []) {
        if (!getAmenity(relatedSlug)) {
            errors.push(`${where}: related amenity "${relatedSlug}" does not exist`);
        }
    }
}

// Every amenity must be reachable from the landing page grid.
const grid = path.join(PUBLIC_DIR, 'index.html');
if (!existsSync(grid)) {
    errors.push('public/index.html is missing');
} else {
    const html = await import('node:fs').then((fs) => fs.readFileSync(grid, 'utf8'));
    if (!html.includes('amenities-grid')) {
        errors.push('public/index.html has no #amenities-grid container to render into');
    }
    if (!html.includes('data/amenities.js')) {
        errors.push('public/index.html does not import js/data/amenities.js');
    }
}

// The detail page and its renderer must both exist, or every link 404s.
for (const required of ['pages/amenity.html', 'js/pages/amenity.js']) {
    if (!existsSync(path.join(PUBLIC_DIR, required))) {
        errors.push(`public/${required} is missing`);
    }
}

console.log(`Checked ${AMENITIES.length} amenities.`);

if (errors.length) {
    console.error('\nProblems found:');
    for (const error of errors) console.error(`  - ${error}`);
    console.error(`\n${errors.length} problem(s).`);
    process.exit(1);
}

console.log('All amenities valid: slugs unique, images present, related links resolve.');