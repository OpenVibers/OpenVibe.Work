'use strict';

/**
 * One city, however a board spells it. The boards write the same place many ways: "München" and "Munich", "Köln" and
 * "Cologne", "Zürich" and "Zurich", "London Office" (production on 2026-10-23: 467 Munich + 159 München, 157 Zürich +
 * 56 Zurich). The listing keeps the board's own words; these helpers make a search for one spelling find all of them
 * and let the home and company pages count one city once.
 *
 *   patternsOf('münchen')   → ['%munich%', '%münchen%', '%muenchen%']   the location filter's LIKE patterns
 *   placeOf('München')      → { key: 'munich', name: 'Munich' }        a place as the pages name it
 *   placeOf('London Office') → { key: 'london', name: 'London' }
 */

// Each city: the name the pages show, then the spellings boards use (lower case; the name's own included).
const CITIES = [
    ['Munich', 'münchen', 'muenchen'],
    ['Cologne', 'köln', 'koeln'],
    ['Zurich', 'zürich', 'zuerich'],
    ['Nuremberg', 'nürnberg', 'nuernberg'],
    ['Düsseldorf', 'dusseldorf', 'duesseldorf'],
    ['Frankfurt', 'frankfurt am main'],
    ['Hanover', 'hannover'],
    ['Vienna', 'wien'],
    ['Geneva', 'genève', 'geneve', 'genf'],
    ['Prague', 'praha'],
    ['Warsaw', 'warszawa'],
    ['Milan', 'milano'],
    ['Lisbon', 'lisboa'],
    ['The Hague', 'den haag', "'s-gravenhage"],
    ['Brussels', 'bruxelles', 'brussel'],
    ['Copenhagen', 'københavn', 'kobenhavn'],
    ['Gothenburg', 'göteborg', 'goteborg'],
    ['Malmö', 'malmo'],
    ['Kraków', 'krakow', 'cracow'],
    ['Wrocław', 'wroclaw'],
    ['Athens', 'athína'],
    ['Bucharest', 'bucurești', 'bucuresti'],
];
const BY_SPELLING = new Map();
for (const [name, ...others] of CITIES) {
    const entry = { key: name.toLowerCase(), name, spellings: [name.toLowerCase(), ...others] };
    for (const sp of entry.spellings) BY_SPELLING.set(sp, entry);
}

// Words a board adds to a city that are not part of it: "London Office", "Berlin (Hybrid)", "Paris HQ". (Not "Area":
// "Bay Area" is a place.) A spelling that is part of other names stays out of CITIES ("roma" is in "Romania").
const NOISE = /\s*(?:\((?:hybrid|remote|on-?site)\)|\b(?:office|hq|headquarters)\b)\s*$/i;

/** % and _ in a place are characters, not wildcards (backslash is LIKE's default escape). */
const literal = (s) => s.replace(/[\\%_]/g, '\\$&');

/** The LIKE patterns a location filter applies: every spelling of a known city, or the term itself. [] for none. */
function patternsOf(term) {
    const t = String(term == null ? '' : term).trim().toLowerCase().slice(0, 120);
    if (!t) return [];
    const bare = t.replace(NOISE, '').trim() || t;
    const city = BY_SPELLING.get(bare);
    return (city ? city.spellings : [bare]).map((sp) => `%${literal(sp)}%`);
}

/** A board's place (the first part of its location) → { key, name }: one key and one name per city. */
function placeOf(text) {
    const raw = String(text == null ? '' : text).split(',')[0].trim().replace(NOISE, '').trim();
    const city = BY_SPELLING.get(raw.toLowerCase());
    if (city) return { key: city.key, name: city.name };
    return { key: raw.toLowerCase(), name: raw };
}

/**
 * Rows of { p: place text, n: count } → [{ place, count }], one per city, its name the most common spelling of an
 * unknown place (the known cities use their own name), the largest first.
 */
function mergePlaces(rows) {
    const byKey = new Map();
    for (const r of rows) {
        if (!r || !r.p) continue;
        const { key, name } = placeOf(r.p);
        if (!key) continue;
        const n = Number(r.n) || 0;
        const e = byKey.get(key) || { place: name, count: 0, top: 0 };
        if (!BY_SPELLING.has(key) && n > e.top) { e.place = name; e.top = n; }
        e.count += n;
        byKey.set(key, e);
    }
    return [...byKey.values()].map(({ place, count }) => ({ place, count })).sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));
}

module.exports = { patternsOf, placeOf, mergePlaces, CITIES };
