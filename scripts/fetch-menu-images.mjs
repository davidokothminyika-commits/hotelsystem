#!/usr/bin/env node
/**
 * scripts/fetch-menu-images.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Downloads one photograph for every seeded menu item into
 * public/assets/images/dining/ and writes the result to the local image
 * manifest so the seed can reference local files instead of remote URLs.
 *
 * WHY THIS EXISTS
 * The restaurant page renders a card per dish. Without an image, every card
 * falls back to a grey placeholder icon and the menu looks unfinished. The
 * photographs come from Wikimedia Commons because its API is public and every
 * file has a human-readable title, so the picture is verifiably the dish that
 * was searched for rather than a plausible-looking guess.
 *
 * The output is committed to the repository. Running this script again is only
 * needed when a dish is added, renamed, or when a better photograph is wanted.
 *
 * RUN
 *   node scripts/fetch-menu-images.mjs              # add any missing dish only
 *   node scripts/fetch-menu-images.mjs --refresh    # re-pick every photograph
 *
 * Without --refresh an already-downloaded file is kept, so the photography
 * cannot silently change between runs.
 *
 * COMMUNICATION
 * Seed (src/database/seed.js) -> reads the `image` field of each MENU_ITEMS row
 * Frontend -> <img src="/assets/images/dining/<slug>.jpg"> via cards.js
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUTPUT_DIR = path.join('public', 'assets', 'images', 'dining');
const MANIFEST = path.join(OUTPUT_DIR, 'manifest.json');
const CREDITS = path.join('public', 'assets', 'images', 'CREDITS.md');

/**
 * Markers delimiting the generated section of CREDITS.md.
 *
 * Everything between them is rewritten from the manifest on every run, so the
 * attribution table can never drift from the files that are actually shipped.
 */
const CREDITS_BEGIN = '<!-- BEGIN GENERATED: dining -->';
const CREDITS_END = '<!-- END GENERATED: dining -->';

/**
 * Re-download a photograph even though the file is already on disk.
 *
 * The default is to keep what is committed, so a re-run cannot silently swap
 * photography out from under a page that was reviewed against it. Refreshing is
 * deliberate: it is how a dish gets a better picture, and it must be reviewed
 * and committed like any other change.
 */
const REFRESH = process.argv.includes('--refresh');

/**
 * The manifest, if a previous run already recorded a dish.
 *
 * The licence and source title are kept alongside the path so
 * CREDITS.md can be regenerated from real data rather than from memory, which
 * matters because CC BY and CC BY-SA require accurate attribution.
 */
function readManifest() {
    if (!existsSync(MANIFEST)) return {};
    try {
        return JSON.parse(readFileSync(MANIFEST, 'utf8'));
    } catch {
        // A corrupt manifest should not block a re-fetch.
        return {};
    }
}

/**
 * Wikimedia Commons search terms, one per seeded menu item.
 *
 * `search` is what the Commons API matches file titles against, so it is kept
 * close to the dish name.
 *
 * `must` is a list of keywords of which at least one has to appear in the file
 * title before the photograph is accepted. Without it, Commons happily returns
 * a car for a search of "martini" or a portrait of the inventor of nachos for
 * a search of "nachos", and a wrong picture is worse than no picture.
 *
 * `avoid` rejects titles containing any of these words. It exists for the
 * handful of searches where the correct subject shares a name with something
 * unrelated, such as a water bottling plant coming back for a bottle of water.
 */
const DISHES = [
    // ---- Breakfast ----
    { slug: 'continental-breakfast', search: 'continental breakfast buffet', must: ['breakfast'] },
    { slug: 'full-english-breakfast', search: 'full English breakfast', must: ['breakfast'] },
    { slug: 'avocado-toast', search: 'avocado toast poached egg', must: ['avocado'] },
    { slug: 'pancake-stack', search: 'pancakes maple syrup', must: ['pancake', 'pancakes'] },

    // ---- Lunch ----
    { slug: 'chicken-caesar-salad', search: 'Caesar salad chicken', must: ['caesar', 'salad'] },
    { slug: 'grilled-vegetable-platter', search: 'roasted vegetable dish', must: ['vegetable', 'vegetables'], avoid: ['chicken', 'rice', 'pasta', 'fish', 'soup', 'salad', 'curry'] },
    { slug: 'club-sandwich', search: 'club sandwich', must: ['sandwich'] },
    { slug: 'margherita-pizza', search: 'Margherita pizza', must: ['pizza'] },
    { slug: 'mushroom-risotto', search: 'mushroom risotto', must: ['risotto'] },

    // ---- Dinner ----
    { slug: 'grilled-salmon', search: 'grilled salmon fillet plated', must: ['salmon'] },
    { slug: 'ribeye-steak', search: 'rib eye steak roast potatoes', must: ['steak', 'ribeye', 'rib eye'] },
    { slug: 'chicken-tikka-masala', search: 'chicken tikka masala', must: ['tikka', 'masala'] },
    { slug: 'pasta-carbonara', search: 'carbonara', must: ['carbonara'] },
    { slug: 'vegetable-curry', search: 'vegetable curry', must: ['curry'] },

    // ---- Drinks ----
    { slug: 'fresh-orange-juice', search: 'orange juice glass', must: ['orange juice'] },
    { slug: 'cappuccino', search: 'cappuccino cup', must: ['cappuccino'] },
    { slug: 'still-water-750ml', search: 'mineral water bottle', must: ['water'], avoid: ['factory', 'plant', 'fountain', 'spring', 'bottling'] },
    { slug: 'house-red-wine', search: 'glass of red wine', must: ['wine'] },
    { slug: 'classic-martini', search: 'dry martini cocktail glass', must: ['martini'] },

    // ---- Desserts ----
    { slug: 'chocolate-lava-cake', search: 'molten chocolate cake', must: ['chocolate', 'lava'] },
    { slug: 'new-york-cheesecake', search: 'cheesecake slice', must: ['cheesecake'] },
    { slug: 'fresh-fruit-platter', search: 'fruit salad bowl', must: ['fruit'] },
    { slug: 'sorbet-of-the-day', search: 'sorbet ice cream bowl', must: ['sorbet', 'ice cream'] },

    // ---- Snacks ----
    { slug: 'chicken-burger', search: 'chicken burger bun', must: ['burger'] },
    { slug: 'french-fries', search: 'french fries plate', must: ['fries', 'chips'] },
    { slug: 'loaded-nachos', search: 'nachos cheese plate', must: ['nacho', 'nachos'] },
    { slug: 'chicken-wings', search: 'buffalo chicken wings', must: ['wing', 'wings'] },
];

/** Commons API endpoint. */
const API = 'https://commons.wikimedia.org/w/api.php';

/**
 * Commons rate limits anonymous clients aggressively and answers with a bare
 * 429. Requests are paced and retried, because a 429 must never be mistaken for
 * "this dish has no photograph" and silently leave a card without an image.
 */
const PACE_MS = 1_200;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches a URL, pacing between calls and backing off on 429. */
async function politeFetch(url, { binary = false } = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await sleep(PACE_MS);

        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'AureliaGrandHotel/1.0 (seed image fetch)' },
            });

            if (response.status === 429) {
                // Exponential backoff: 1.2s, 2.4s, 4.8s, 9.6s, 19.2s.
                await sleep(PACE_MS * 2 ** (attempt - 1));
                continue;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`gave up after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'rate limited'}`);
}

/**
 * Searches Commons for the best photograph for a dish.
 *
 * Results are filtered to files at least 600px wide so a card never renders a
 * blurry thumbnail, and to titles that actually mention the dish.
 *
 * @param {{search: string, must: string[], avoid?: string[]}} dish
 * @returns {Promise<{url: string, title: string, licence: string}|null>}
 *   The chosen photograph, or null when nothing matched.
 */
async function findPhotograph({ search, must, avoid = [] }) {
    const url = new URL(API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', `filetype:bitmap ${search}`);
    url.searchParams.set('gsrnamespace', '6'); // File namespace only.
    url.searchParams.set('gsrlimit', '20');
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|extmetadata');
    url.searchParams.set('iiurlwidth', '900');

    const data = await politeFetch(url);
    const pages = Object.values(data?.query?.pages || {});

    // Search relevance order is preserved by the API, but pages arrive as an
    // object, so sort back onto the search index before picking a winner.
    const ranked = pages
        .map((page) => ({ page, index: page.index ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.index - b.index);

    for (const { page } of ranked) {
        const info = page.imageinfo?.[0];
        if (!info?.thumburl || info.width < 600) continue;

        const title = page.title.replace(/^File:/, '');

        // The title must name the dish, otherwise Commons has returned
        // something loosely related: a car called a Martini, a portrait of the
        // person who invented nachos. Showing that on a menu is worse than
        // showing nothing at all.
        const haystack = title.toLowerCase();
        if (!must.some((keyword) => haystack.includes(keyword.toLowerCase()))) continue;

        if (avoid.some((keyword) => haystack.includes(keyword.toLowerCase()))) continue;

        // Skip anything with no usable licence: a public site should not ship
        // an image whose redistribution terms are unknown.
        const licence = info.extmetadata?.LicenseShortName?.value;
        if (!licence) continue;

        return { url: info.thumburl, title, licence };
    }

    return null;
}

/** Downloads a URL to disk. */
async function download(url, destination) {
    const buffer = await politeFetch(url, { binary: true });
    if (buffer.length < 5_000) throw new Error(`suspiciously small (${buffer.length} bytes)`);

    await writeFile(destination, buffer);
    return buffer.length;
}

/**
 * Rewrites the dining table in CREDITS.md from the manifest.
 *
 * CC BY and CC BY-SA require credit to the author, so the table is part of
 * shipping the images rather than a nicety. Generating it means adding a dish
 * cannot produce a picture with no attribution, and a licence that changed
 * upstream cannot be left stale in the prose.
 *
 * The surrounding file is left untouched: only the region between the markers
 * is replaced, so hand-written guidance survives a re-fetch.
 */
async function writeCredits(manifest) {
    if (!existsSync(CREDITS)) {
        console.warn(`\nNo ${CREDITS} to update. Attribution is required by CC BY and CC BY-SA.`);
        return;
    }

    const credits = await readFile(CREDITS, 'utf8');
    const begin = credits.indexOf(CREDITS_BEGIN);
    const end = credits.indexOf(CREDITS_END);

    if (begin === -1 || end === -1 || end < begin) {
        console.warn(`\n${CREDITS} has no generated section (${CREDITS_BEGIN} / ${CREDITS_END} missing); table not updated.`);
        return;
    }

    const rows = Object.entries(manifest)
        .map(([slug, entry]) => {
            const title = entry.title || slug;
            const link = entry.commonsUrl || `https://commons.wikimedia.org/wiki/Special:Search?search=${encodeURIComponent(title)}`;
            return `| \`${slug}.jpg\` | [${title}](${link}) | ${entry.licence || 'unknown'} |`;
        })
        .join('\n');

    const table = [
        CREDITS_BEGIN,
        '| File | Commons source | Licence |',
        '| --- | --- | --- |',
        rows,
    ].join('\n');

    // A blank line before the closing marker, so the end marker does not end up
    // glued to the last table row.
    const updated = credits.slice(0, begin) + `${table}\n\n` + credits.slice(end);
    if (updated !== credits) {
        await writeFile(CREDITS, updated);
        console.log(`Attribution table regenerated in ${CREDITS}`);
    }
}

async function main() {
    await mkdir(OUTPUT_DIR, { recursive: true });

    const previous = readManifest();
    const manifest = {};
    const failures = [];

    for (const dish of DISHES) {
        const destination = path.join(OUTPUT_DIR, `${dish.slug}.jpg`);
        const publicPath = `/assets/images/dining/${dish.slug}.jpg`;

        // Already downloaded: keep the committed file rather than re-fetching,
        // so a re-run cannot silently swap the photography. Attribution from a
        // previous run is carried over.
        if (!REFRESH && existsSync(destination)) {
            const cached = previous[dish.slug];
            manifest[dish.slug] = typeof cached === 'string'
                ? { path: cached, title: null, licence: null, source: 'commons.wikimedia.org' }
                : { ...cached, path: publicPath };

            if (!manifest[dish.slug].licence) {
                console.log(`  skip    ${dish.slug} (licence unknown, re-run with --refresh to recheck)`);
            } else {
                console.log(`  skip    ${dish.slug}`);
            }
            continue;
        }

        if (REFRESH && existsSync(destination)) console.log(`  refresh ${dish.slug}`);

        try {
            const photo = await findPhotograph(dish);
            if (!photo) throw new Error('no photograph with a matching title');

            const bytes = await download(photo.url, destination);
            manifest[dish.slug] = {
                path: publicPath,
                title: photo.title,
                licence: photo.licence,
                source: 'commons.wikimedia.org',
                commonsUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(photo.title)}`,
            };

            console.log(`  ok      ${dish.slug} (${Math.round(bytes / 1024)} KB, ${photo.licence})`);
            console.log(`          ${photo.title}`);
        } catch (error) {
            failures.push(`${dish.slug}: ${error.message}`);
            console.error(`  FAILED  ${dish.slug}: ${error.message}`);
        }
    }

    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 4)}\n`);

    await writeCredits(manifest);

    console.log(`\n${Object.keys(manifest).length}/${DISHES.length} images available`);
    console.log(`Attribution written to ${MANIFEST}. Keep it with the code: CC BY and CC BY-SA require it.`);

    if (failures.length > 0) {
        console.error(`\n${failures.length} dish(es) have no image:`);
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error('\nThose cards fall back to the placeholder icon.');
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('Fatal:', error);
    process.exitCode = 1;
});