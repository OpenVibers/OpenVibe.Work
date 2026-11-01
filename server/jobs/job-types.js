'use strict';

/**
 * The job types this service speaks, in one place (plan 2026-11-01).
 *
 * The boards write the type in their own words and in their own language: Arbeitnow says "unbefristeter
 * arbeitsvertrag", RemoteOK says "Experienced, Permanent, Full time", a French board says "CDI - contrat à durée
 * indéterminée", a Dutch board says "vast dienstverband". A reader should not have to know that: the facet shows one
 * set of nine types, in English, and the filter takes the same nine.
 *
 * So a raw job_type is mapped to the canonical keys it names. The synonyms below are the words the boards really
 * use (read from the live rows, counts only), and a word that is not in the table is dropped: a seniority
 * ("Berufserfahren", "Experienced", "Entry", "Senior", "Mid"), a manager's title, a workplace or a company's name is
 * not a job type and is never shown.
 *
 * One table, two readers: the mapper here (JavaScript) decides what a card, a detail page and the facet say, and the
 * very same patterns are handed to PostgreSQL, so a facet count and the filter it links to can never disagree.
 */

// The nine types, in the order the facet shows them.
const CANONICAL = [
    { key: 'full-time', label: 'Full time' },
    { key: 'part-time', label: 'Part time' },
    { key: 'permanent', label: 'Permanent' },
    { key: 'temporary', label: 'Temporary' },
    { key: 'contract', label: 'Contract' },
    { key: 'freelance', label: 'Freelance' },
    { key: 'internship', label: 'Internship' },
    { key: 'apprenticeship', label: 'Apprenticeship' },
    { key: 'volunteer', label: 'Volunteer' },
];

const KEYS = CANONICAL.map((t) => t.key);
const LABELS = Object.fromEntries(CANONICAL.map((t) => [t.key, t.label]));

/**
 * The words each type goes by, in the languages the boards write: German, French, Dutch, Spanish and English, in
 * the spelling each board uses (an umlaut, an accent, an underscore, a hyphen). A board that drops the accent
 * ("duree" for "durée") is covered too, because the board's spelling is the one we have to match.
 *
 * Only a word that names a type is here. Seniority ("Berufserfahren", "Berufseinstieg", "Experienced", "Entry",
 * "Senior", "Mid"), a title ("Teamleitung", "Manager", "Executive"), a school ("Student college") and a company's
 * name are deliberately absent: they are dropped, never shown.
 */
const SYNONYMS = {
    'full-time': [
        'full time', 'fulltime', 'vollzeit', 'vollzeitstelle', 'temps plein', 'plein temps', 'voltijd', 'voltijds',
        'tiempo completo', 'jornada completa', 'tiempo integral',
    ],
    'part-time': [
        'part time', 'parttime', 'teilzeit', 'teilzeitstelle', 'teilzeitbeschäftigung', 'minijob', 'nebentätigkeit',
        'nebenbeschäftigung', 'hilfstätigkeit', 'werkstudent', 'working student', 'side', 'side job', 'deeltijd',
        'deeltijdcontract', 'temps partiel', 'medio tiempo', 'tiempo parcial', 'media jornada',
    ],
    permanent: [
        'permanent', 'permanent employment', 'permanent contract', 'permanent position', 'festanstellung',
        'unbefristet', 'unbefristeter arbeitsvertrag', 'unbefristetes arbeitsverhältnis', 'cdi',
        'contrat à durée indéterminée', 'contrat a duree indeterminee', 'indefinite contract', 'indefinite employment',
        'open-ended contract', 'open ended contract', 'onbepaalde tijd', 'onbepaalde', 'vast dienstverband',
        'vast contract', 'contrato indefinido', 'contrato fijo',
    ],
    temporary: [
        'temporary', 'temporary employment', 'temporary work', 'temporary contract', 'fixed term', 'fixed-term contract',
        'fixed-term', 'befristet', 'befristeter arbeitsvertrag', 'befristetes arbeitsverhältnis', 'cdd',
        'contrat à durée déterminée', 'contrat a duree determinee', 'interim', 'ctt', 'tijdelijk contract',
        'tijdelijk', 'tijdelijke', 'bepaalde tijd', 'contrato temporal', 'temporal',
    ],
    contract: [
        'contract', 'contract 6-12 months', 'contrat', 'vertrag',
    ],
    freelance: [
        'freelance', 'freelancer', 'freiberuflich', 'freiberufler', 'freiberufliche', 'selbstständiger',
        'selbständiger', 'self-employed', 'self employed', 'auto-entrepreneur', 'travailleur indépendant',
        'travailleur independant', 'indépendant', 'indepependant', 'independent', 'contractor',
        'independent contractor', 'zzp', 'service provider',
    ],
    internship: [
        'internship', 'intern', 'praktikum', 'praktikumsvertrag', 'praktikant', 'stage', 'stage de fin d\'études',
        'stage de fin d etudes', 'convention de stage', 'trainee', 'traineeship', 'prácticas', 'practicas',
    ],
    apprenticeship: [
        'apprenticeship', 'apprentice', 'ausbildung', 'ausbildungsberuf', 'lehrvertrag', 'lehrling', 'alternance',
        'dual studies', 'duales studium', 'apprentissage', 'aprendizaje',
    ],
    volunteer: [
        'volunteer', 'volunteering', 'bénévolat', 'benevolat', 'ehrenamt', 'volontär', 'volontaire',
    ],
};

// A word may be written with a space, a hyphen or an underscore between its words, and the boards differ on the
// accents ("durée", "duree"), so a pattern accepts all of them.
const SEPARATOR = '[- _]+';
const WORD_BEFORE = '(^|[^a-z0-9])';
const WORD_AFTER = '([^a-z0-9]|$)';

const escapeRe = (ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch);

/**
 * One synonym → one pattern: the words, separated by a space, a hyphen or an underscore, bounded by a non-letter on
 * either side, so "contract" never matches "contractor" and "befristet" never matches "unbefristet".
 */
function patternOf(synonym) {
    const words = String(synonym).toLowerCase().split(' ').map((word) => [...word].map(escapeRe).join(''));
    return WORD_BEFORE + words.join(SEPARATOR) + WORD_AFTER;
}

/** The patterns of every type, and the same patterns as one JavaScript regular expression each. */
const PATTERNS = {};
const COMPILED = {};
for (const key of KEYS) {
    PATTERNS[key] = SYNONYMS[key].map(patternOf);
    COMPILED[key] = PATTERNS[key].map((p) => new RegExp(p));
}

/**
 * A raw job_type → the canonical keys it names. The raw value is a board's list of words, so it is read part by part
 * (on commas and slashes) and every part is matched against the synonyms. A listing that names two types ("Permanent,
 * Full time") gets both, so it counts under each and either filter finds it. A raw value that names no type (a
 * seniority, a title, a company's name, nothing at all) gets none: it is dropped, never shown raw.
 */
function mapTypes(raw) {
    const text = String(raw == null ? '' : raw).toLowerCase().trim();
    if (!text) return [];
    const parts = text.split(/[,;/]/).map((p) => p.trim()).filter(Boolean);
    const named = KEYS.filter((key) => COMPILED[key].some((re) => parts.some((part) => re.test(part))));
    return named;
}

/** The canonical labels a raw job_type names, in the order the facet shows them. */
const labelsOf = (raw) => mapTypes(raw).map((key) => LABELS[key]);

/** The canonical labels of a raw job_type as one line: "Permanent, Full time". */
const labelText = (raw) => labelsOf(raw).join(', ');

/** The label of one canonical key. */
const label = (key) => LABELS[key] || '';

/**
 * The canonical key a reader's ?type= names, or null when the value is not one of the nine. "Full time", "full_time"
 * and "FULL-TIME" all mean the full-time type; anything else ("unbefristeter arbeitsvertrag") is not a canonical type
 * and keeps the old behaviour of a plain text search over the boards' own words.
 */
function canonicalKey(value) {
    const norm = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_]+/g, '-');
    return KEYS.includes(norm) ? norm : null;
}

/** The patterns PostgreSQL needs to find the listings of one canonical type. */
const patternsOf = (key) => (PATTERNS[key] || []).slice();

module.exports = { CANONICAL, KEYS, LABELS, SYNONYMS, mapTypes, labelsOf, labelText, label, canonicalKey, patternsOf, patternOf };
