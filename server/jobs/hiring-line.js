'use strict';

/**
 * A job board post written as one pipe-separated line, split into the fields a listing has.
 *
 * Hacker News "Who is hiring" comments (and boards that copy its style) keep a whole listing in the first line of a
 * post:
 *
 *   https://www.monumental.co/ | Amsterdam, The Netherlands | Full Time | Onsite at MONUMENTAL
 *   Mechanical Engineer, Electrical Engineer, Robotic Controls Engineer | New York, NY | ONSITE | Full-time | $220K-$300K at Nirvana Robotics
 *
 * Kept whole, that line is not a title: a URL, a place, the terms and the pay all end up in it, and the card says the
 * same things twice in the wrong places. This module reads the line the way a person does:
 *
 *   company  from "at X", the "X is hiring …" opening, the first segment that is a name, or a URL's host
 *   roles    the segments that name a role; several are kept ("the first +N more roles")
 *   place    a location segment (a city, a country, "Remote (US)", a time zone), never a role or a term
 *   terms    on-site / remote / hybrid, full / part time, contract, visa and relocation
 *   pay      a salary segment, in the poster's own words
 *
 * The title is "Role at Company", or "First role +N more roles at Company"; with no role named it is the company
 * alone, and a URL is never a title. The line itself is returned so the description can keep it — nothing is lost.
 *
 * It is deliberately conservative: a token that names none of these is dropped rather than shown in the wrong field,
 * and a line with no company at all is not a listing (server/jobs/sources.js's thin-listing gate holds it). No I/O.
 */

/** The rule's name, stored on the listing (work_listings.title_rule) so a re-derive never reads its own output back. */
const TITLE_RULE = 'hn-line@1';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const letters = (s) => (String(s == null ? '' : s).match(/\p{L}/gu) || []).length;
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** The job types the boards name, in the words this module reports (server/jobs/job-types.js maps them for display). */
const TYPES = [
    { label: 'Full time', re: /\bfull[\s-]?time\b|\bfulltime\b|\bft\b/i },
    { label: 'Part time', re: /\bpart[\s-]?time\b|\bparttime\b|\bpt\b/i },
    { label: 'Apprenticeship', re: /\bapprentic(?:e|eship)\b/i },
    { label: 'Internship', re: /\bintern(?:ship)?s?\b|\bco-?ops?\b/i },
    { label: 'Freelance', re: /\bfreelanc(?:e|er)\b|\bfractional\b/i },
    { label: 'Contract', re: /\bcontract(?:or|s)?\b|\bcontract-to-hire\b|\bb2b\b|\b1099\b|\bfixed[\s-]?term\b/i },
    { label: 'Permanent', re: /\bpermanent\b|\bcdi\b/i },
    { label: 'Temporary', re: /\btemporary\b|\binterim\b/i },
];

const REMOTE_RE = /\bremote(?:[-\s]?first)?\b|\banywhere\b|\bworldwide\b|\bwork\s+(?:from|at)\s+home\b|\bdistributed\s+team\b/i;
const NO_REMOTE_RE = /\bno\s+remote\b|\bnot\s+remote\b|\bremote\s+not\s+(?:possible|available)\b/i;
const ONSITE_RE = /\bon[\s-]?site\b|\bin[\s-]?person\b|\bin[\s-]?office\b|\bon[\s-]?prem(?:ise|ises)?\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const VISA_RE = /\bvisa\b|\bsponsor(?:ship|s)?\b/i;
const NO_VISA_RE = /\bno\s+(?:visa\s+)?sponsor|\bnot\s+(?:able|offer|offering)\b[^.]*\bsponsor|\bno\s+sponsorship\b|\bwithout\s+sponsorship\b/i;
const AUTH_RE = /\bcitizenship\b|\bwork\s+authori[sz]ation\b|\bsecurity\s+clearance\b|\bclearance\s+required\b|\bgreen\s+card\b/i;
const RELOCATION_RE = /\brelocation\b|\brelocate\b/i;

/**
 * A role's own words. Two strengths: a segment is a role when it names any of these, and several comma/plus-separated
 * roles are only split apart when every part names a strong one — so "Senior Java, C# and React engineers" stays one
 * role, while "Mechanical Engineer, Electrical Engineer" becomes two.
 */
const ROLE_NOUN = /\b(?:engineers?|developers?|designers?|managers?|scientists?|analysts?|architects?|leads?|directors?|administrators?|admins?|consultants?|specialists?|executives?|officers?|recruiters?|marketers?|writers?|editors?|researchers?|interns?|founders?|swe|sde|pm|tpm|em|qa|sre|devops|cto|ceo|cfo|coo|vp|president|heads?|coordinators?|strategists?|accountants?|attorneys?|lawyers?|professors?|technicians?|operators?|producers?|artists?|assistants?|associates?|representatives?|reps?|hires?|ba|po|sales|growth|marketing|product|operations|finance|legal|people|talent|security|infrastructure|platform|backend|frontend|full[\s-]?stack|mobile|cloud|data|ml|ai|robotics?|mechanical|electrical|controls?|embedded|firmware|hardware|software|systems?|network|database|devrel|advocate|evangelist|support|success|customer|partnerships?|revenue|gtm|go[\s-]?to[\s-]?market|agents?)\b/i;
const ROLE_STRONG = /\b(?:engineers?|developers?|designers?|managers?|scientists?|analysts?|architects?|leads?|directors?|administrators?|admins?|consultants?|specialists?|executives?|officers?|recruiters?|marketers?|writers?|editors?|researchers?|interns?|founders?|swe|sde|pm|tpm|em|qa|sre|devops|cto|ceo|cfo|coo|vp|president|heads?|coordinators?|strategists?|accountants?|attorneys?|lawyers?|professors?|technicians?|operators?|producers?|artists?|assistants?|associates?|representatives?|reps?|hires?|ba|po|go[\s-]?to[\s-]?market|advocate|evangelist)\b/i;

/** A company often names what it does; that suffix keeps "Charge Robotics" a name even though "robotics" is a role word. */
const COMPANY_SUFFIX = /\b(?:inc|ltd|limited|llc|corp|corporation|company|co|labs?|systems?|technologies|technology|tech|ai|studio|studios|health|capital|ventures?|group|solutions|aerospace|pharmacy|trading|partners|foundation|institute|university|bank|media|networks?|robotics|science|sciences|design|consulting|agency|division|startup|holdings|finance|markets?|commodit(?:y|ies)|software)\b/i;

/** A first segment that opens a sentence or asks a question is not a company name. */
const NOT_A_COMPANY_START = /^(?:no|not|none|without|unknown|various|multiple|several|looking|seeking|hiring|we|our|this|the|about|backed|join|apply|role|job|location|remote|onsite|hybrid|full|part|contract|intern)\b/i;

/** A role phrase opens with a level or a quantity ("Senior Backend Engineer", "Multiple roles"), never a company. */
const ROLE_TITLE_START = /^(?:senior|staff|lead|principal|junior|sr\.?|jr\.?|entry|mid|chief|head|vice|vp|founding|multiple|several|various)\b/i;
const NOT_A_ROLE_START = /^(?:closed|stop|apply|email|url|http|www|see|read|more|details|salary|compensation|equity|visa|relocation|seed|series|yc|stealth|profitable|pmf|fintech|healthtech|edtech|ai\/ml)\b/i;

const MONEY_RE = /(?:[$€£]\s?\d|\b\d[\d,.]*\s?[kK]\b|\b\d{2,3}[,.]\d{3}\b|\b(?:usd|eur|gbp|cad|aud|chf)\b)/i;
const COMP_RE = /\b(?:salary|compensation|comp|ote|equity|stock|share\s+options|options|bonus|commission|hourly|per\s+hour|\/\s?hr|annuali[sz]ed|revenue\s+share)\b/i;
const PAY_AMOUNT_RE = /\b(?:ote|equity|stock|share\s+options|options|bonus|commission|revenue\s+share)\b/i;

const PLACE_RE = /\b(?:remote|hybrid|on[\s-]?site|in[\s-]?person|in[\s-]?office|office|worldwide|anywhere|global|international|united\s+states|uk|u\.k\.|united\s+kingdom|europe|european|emea|apac|latam|americas|north\s+america|south\s+america|asia|africa|australia|canada|mexico|brazil|argentina|colombia|chile|peru|uruguay|germany|france|netherlands|belgium|spain|portugal|italy|austria|switzerland|sweden|norway|denmark|finland|iceland|ireland|poland|romania|bulgaria|czech|slovakia|hungary|ukraine|estonia|latvia|lithuania|serbia|croatia|slovenia|greece|turkey|israel|india|pakistan|bangladesh|philippines|indonesia|malaysia|singapore|vietnam|thailand|japan|korea|china|taiwan|hong\s+kong|australia|new\s+zealand|south\s+africa|nigeria|kenya|egypt|morocco|uae|dubai|saudi|qatar|time\s*zones?|hours|overlap|bay\s+area|sf\s+bay|silicon\s+valley|peninsula)\b/i;
const PLACE_CODE_RE = /\b(?:US|UK|EU|USA|NYC|SF|LA|DC)\b/;
const TIMEZONE_RE = /\b(?:CET|CEST|PST|PDT|EST|EDT|MST|MDT|CST|CDT|UTC|GMT|PT|ET|CT|MT)(?:[+-]\d{1,2})?\b/;
const TIME_CONTEXT_RE = /\b(?:remote|time\s*zones?|hours|overlap|from|to)\b|[±]/i;
const PLACE_COMMA_RE = /,\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s|,|$)/;
const PLACE_CITY_RE = /\b(?:london|berlin|paris|amsterdam|rotterdam|utrecht|munich|münchen|zurich|zürich|geneva|stockholm|copenhagen|oslo|helsinki|dublin|lisbon|barcelona|madrid|milan|rome|vienna|prague|warsaw|krakow|bucharest|budapest|athens|istanbul|tel\s+aviv|bangalore|bengaluru|mumbai|delhi|singapore|tokyo|seoul|sydney|melbourne|auckland|toronto|vancouver|montreal|new\s+york|brooklyn|san\s+francisco|san\s+diego|san\s+jose|palo\s+alto|mountain\s+view|redwood\s+city|berkeley|oakland|seattle|boston|chicago|denver|boulder|atlanta|miami|los\s+angeles|austin|dallas|houston|phoenix|portland|pittsburgh|philadelphia|raleigh|durham|washington|arlington|salt\s+lake\s+city|provo|mexico\s+city|são\s+paulo|sao\s+paulo|buenos\s+aires|bogotá|bogota|santiago)\b/i;

/** A URL's host, from an http(s) URL or a bare domain ("k2space.com", "startuphakk.com/jobs"). */
function hostOf(value) {
    const s = String(value == null ? '' : value).trim();
    try {
        const u = new URL(s);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch { /* a bare domain is not a URL until the pattern below says it is */ }
    const m = /^((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/\S*)?$/i.exec(s);
    return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}

/** The URLs a segment carries, whose text is removed before the segment is read as anything else. */
function stripUrls(text) {
    return String(text)
        .replace(/\((?:https?:\/\/|www\.)[^)]*\)/gi, ' ')
        .replace(/https?:\/\/[^\s)]+/gi, ' ')
        .replace(/\bwww\.[^\s)]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Whether the whole segment is an http(s) URL (so it is a link, not a name, place or role). A bare domain can be a
 * company's name ("Planlab.ai") and is left to the caller to read as one. */
function isUrlSegment(text) {
    const s = String(text == null ? '' : text).trim();
    return /^https?:\/\/\S+$/i.test(s) || /^www\.\S+$/i.test(s);
}

/** A segment that is only a pay amount / compensation line. "Compensation in the link below" is neither. */
function looksPay(text) {
    const s = String(text == null ? '' : text);
    return MONEY_RE.test(s) || (PAY_AMOUNT_RE.test(s) && !ROLE_STRONG.test(s));
}

/** The pay a segment carries, and what is left of it ("Full time, $150k" → "$150k"). */
function takePay(text) {
    const s = String(text == null ? '' : text).trim();
    if (!looksPay(s)) return null;
    // A segment can mix terms and pay ("Full-time, $150K"): keep the parts that name money or compensation.
    const parts = s.replace(/\s*\/\s*(hour|hr|month|year|annum|week|day)\b/gi, ' per $1')
        .split(/\s*;\s*|,(?!\d{3}\b)|\s+\/\s+/).filter(Boolean);
    const kept = parts.filter((p) => MONEY_RE.test(p) || (COMP_RE.test(p) && !TYPES.some((t) => t.re.test(p))));
    const pay = kept.length && kept.join(', ').toLowerCase() !== s.toLowerCase() ? kept.join(', ') : s;
    if (pay === s && TYPES.some((t) => t.re.test(s)) && !MONEY_RE.test(s)) return null; // "Equity, full-time" is not a pay line
    const rest = kept.length && kept.join(', ').toLowerCase() !== s.toLowerCase()
        ? parts.filter((p) => !kept.includes(p)).join(', ')
        : s;
    return { text: clip(pay, 160), rest: rest === s ? '' : rest };
}

/** The job types a segment names, in the order they appear. */
function typesOf(text) {
    const s = String(text == null ? '' : text);
    // "(PT to ET overlap preferred)" is Pacific Time, not part time; the same for FT when it is a time zone.
    const timeZone = TIMEZONE_RE.test(s) && TIME_CONTEXT_RE.test(s) || /\b(?:PT|FT)\s+(?:to|and|or)\s+(?:ET|CT|MT|PT)\b/i.test(s);
    const probe = timeZone ? s.replace(/\b(?:FT|PT)\b/gi, ' ') : s;
    return TYPES.filter((t) => t.re.test(probe)).map((t) => t.label);
}

/** The place a segment names, cleaned of the terms around it, or null when it names none. */
function placeOf(text) {
    let s = stripUrls(text);
    if (!s || looksPay(s)) return null;
    if ((VISA_RE.test(s) || AUTH_RE.test(s)) && !PLACE_COMMA_RE.test(s) && !PLACE_CITY_RE.test(s)) return null;
    const comma = PLACE_COMMA_RE.test(s) && !ROLE_NOUN.test(s);
    const city = PLACE_CITY_RE.test(s);
    const zone = TIMEZONE_RE.test(s) && (TIME_CONTEXT_RE.test(s) || s.replace(TIMEZONE_RE, '').replace(/[\s(),./+-]/g, '').length < 2);
    const named = PLACE_RE.test(s) || PLACE_CODE_RE.test(s) || comma || city || zone;
    if (!named) return null;
    // "Mechanical Engineer, Electrical Engineer" and "Founding Account Executive (US)": a comma or a work-authorisation
    // code between roles is not a place.
    if (ROLE_STRONG.test(s) && !PLACE_RE.test(s) && !city) return null;
    s = s
        .replace(/\b(?:full[\s-]?time|part[\s-]?time|fulltime|parttime|contract(?:or)?|freelance|fractional|permanent|temporary|internship|interns?|co-?ops?)\b/gi, ' ')
        .replace(/\b(?:visa\s+sponsorship|no\s+visa\s+sponsorship|visa|sponsorship|relocation)\b/gi, ' ')
        .replace(/\b(?:citizenship\s+required|work\s+authori[sz]ation\s+required|security\s+clearance\s+required|clearance\s+required)\b/gi, ' ')
        .replace(/\bhybrid\b/gi, ' ')
        .replace(/\b(?:on[\s-]?site|in[\s-]?person|in[\s-]?office)\b/gi, ' ')
        .replace(/\b(?:no\s+remote|not\s+remote)\b/gi, ' ')
        .replace(/\(\s*(?:\d+\s*days?[^)]*|in[\s-]?office[^)]*|some\s+crossover[^)]*)\)/gi, ' ')
        .replace(/\b\d+\s*days?\b(?:\s*(?:a|\/|per)\s*(?:week|wk))?/gi, ' ')
        .replace(/\bin\s+office\b/gi, ' ')
        .replace(/\b(?:based|located)\s+in\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,;:/|.·•–—-]+|[\s,;:/|.·•–—-]+$/g, '')
        .replace(/^(?:in|at)\s+/i, '')
        .replace(/\s+(?:or|and)\s*$/i, '')
        .replace(/\s*\/\s*(?:or|and)\s+/gi, ' / ')
        .replace(/^(?:or|and)\s+/i, ' ')
        .replace(/\(\s*\)/g, ' ')
        .replace(/\((?:[^)]*\b(?:require[sd]?|preferred|only|hours|days?|week)\b[^)]*)\)/gi, ' ')
        .replace(/\b(?:preferred|required|only)\b/gi, ' ')
        .replace(/^(?:or|and)\s+/i, ' ')
        .replace(/\s+(?:or|and)\s*$/i, '')
        .replace(/\s*,\s*(?=,|$)/g, '')
        .replace(/\s*,\s*/g, ', ')
        .replace(/^[\s,;:/|.·•–—-]+|[\s,;:/|.·•–—-]+$/g, '')
        .trim();
    s = s.replace(/^\(([^()]+)\)$/, '$1').replace(/^(?:or|and)\s+/i, '').trim();
    if (letters(s) < 2 || s.length > 100) return null;
    if (/\b(?:looking|apply|description|we\s+are)\b/i.test(s)) return null;
    return clip(s, 160);
}

/** Whether a cleaned string reaches this module's bar for a company name. */
function looksLikeCompany(text) {
    const s = clip(text, 160);
    if (letters(s) < 2 || s.length > 120) return false;
    if (isUrlSegment(s) || NOT_A_COMPANY_START.test(s)) return false;
    if (TYPES.some((t) => t.re.test(s))) return false;
    if (VISA_RE.test(s) || AUTH_RE.test(s)) return false;
    if (looksPay(s)) return false;
    if (placeOf(s)) return false;
    if (/\b(?:is|are|was|were)\b/i.test(s) && s.split(/\s+/).length > 6) return false;
    if (ROLE_NOUN.test(s) && ROLE_TITLE_START.test(s)) return false;
    if (ROLE_NOUN.test(s) && s.split(/\s+/).length <= 8 && !COMPANY_SUFFIX.test(s)) return false;
    // A bare time zone is a place, not a company, however it is punctuated.
    if (/[<>]/.test(s) && TIMEZONE_RE.test(s)) return false;
    return true;
}

/** A company name, without a trailing parenthetical URL or a leading "at". */
function cleanCompany(text) {
    return clip(String(text == null ? '' : text)
        .replace(/^[\s\-–—,:]+|[\s\-–—,:]+$/g, '')
        .replace(/\s*\((?:https?:\/\/|www\.)[^)]*\)\s*$/gi, '')
        // A descriptive bracket ("(stealth, regulated commodity markets infrastructure)") is not part of the name;
        // a short one ("(Series B)", "(YC S24)") is how the poster identifies the company.
        .replace(/\s*\(([^)]*)\)\s*$/g, (m, inner) => (inner.includes(',') || inner.split(/\s+/).length > 3 ? '' : m))
        .replace(/\s+/g, ' '), 120);
}

/**
 * The company a line names: "at X" (the last such segment), the "X is hiring …" opening, the first segment that is a
 * name, or a URL's host. The segments array is mutated: the company's text is removed from the segment it was in, so
 * the rest of that segment (the pay before "at X", the role before "at X") is still read.
 */
function takeCompany(segments) {
    // "X is hiring …": the company is the subject, the rest is the role.
    const opening = /^(.+?)\s+(?:is|are|was|were)\s+hiring\b(?:\s+(?:a|an|for|the)\b)?\s*(.*)$/i.exec(segments[0] || '');
    if (opening) {
        const company = cleanCompany(opening[1]);
        if (looksLikeCompany(company)) {
            segments[0] = opening[2].trim();
            return company;
        }
    }
    // "… | $220K-$300K at Nirvana Robotics" or "… | Onsite at MONUMENTAL": the last "at X" names the company.
    for (let i = segments.length - 1; i >= 0; i--) {
        const m = /(?:^|\s)at\s+([^|]+?)\s*$/i.exec(segments[i]);
        if (!m) continue;
        const company = cleanCompany(m[1]);
        if (!looksLikeCompany(company)) continue;
        segments[i] = segments[i].slice(0, m.index).trim();
        return company;
    }
    // The first segment that is a name.
    for (let i = 0; i < segments.length; i++) {
        const cleaned = cleanCompany(stripUrls(segments[i]));
        if (!cleaned) continue;
        if (looksLikeCompany(cleaned)) {
            segments[i] = '';
            return cleaned;
        }
    }
    // A URL's host, when the line names no company but links one.
    for (let i = 0; i < segments.length; i++) {
        const host = hostOf(segments[i]) || hostOf(stripUrls(segments[i]));
        if (host) {
            segments[i] = stripUrls(segments[i]) && !isUrlSegment(stripUrls(segments[i])) ? stripUrls(segments[i]) : '';
            return host;
        }
    }
    return '';
}

/** Whether a cleaned segment names a role, rather than a tagline, a place, a term or a pay line. */
function looksLikeRole(text) {
    const s = clip(text, 200);
    if (letters(s) < 2 || s.length > 160) return false;
    if (NOT_A_ROLE_START.test(s)) return false;
    if (looksPay(s) || typesOf(s).length || VISA_RE.test(s) || AUTH_RE.test(s)) return false;
    if (/\b(?:is|are|we|our|you|your)\b/i.test(s) && s.split(/\s+/).length > 5) return false;
    if (/^(?:building|making|shipping|helping|join|work(?:ing)?\s+with|about|the\s+team|series|seed)\b/i.test(s)) return false;
    if (ROLE_NOUN.test(s)) return true;
    return /^(?:multiple|various|several)\b/i.test(s) && /\broles?\b/i.test(s);
}

/** The role text with the leading "hiring a …" / "looking for …" / separators cleaned off. */
function cleanRole(text) {
    let s = stripUrls(text)
        .replace(/^[\s,;:+/&|–—-]+|[\s,;:+/&|–—-]+$/g, '')
        .replace(/^(?:we(?:'re| are)\s+)?(?:hiring|looking\s+for|seeking|recruiting|searching\s+for)\b\s*(?:a|an|the)?\s*/i, '')
        .replace(/^[\s,;:+/&|–—-]+|[\s,;:+/&|–—-]+$/g, '')
        .replace(/\.$/, '')
        .replace(/\.\s.*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    // "Engineers to work on event-driven, distributed systems …" is a description of the job, not its title.
    s = s.replace(/^((?:[\w/&.+-]+\s+){0,4}(?:engineers?|developers?|designers?|managers?|scientists?|architects?|leads?|directors?))\s+(?:to|who|that)\s+.*$/i, '$1');
    if (letters(s) < 2) return '';
    return clip(s, 140);
}

/** Several roles in one segment, split on a comma, semicolon, plus or "&" only between parenthesised groups. */
function splitRoles(text) {
    const s = String(text || '').trim();
    if (!s || /^(?:multiple|various|several)\b/i.test(s)) return [s];
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (depth === 0) {
            if (ch === ',' || ch === ';') { parts.push(cur); cur = ''; continue; }
            if ((ch === '+' || ch === '&') && /\s/.test(s[i - 1] || '') && /\s/.test(s[i + 1] || '')) { parts.push(cur); cur = ''; continue; }
            if (ch === ' ' && /^ and $/i.test(s.slice(i - 1, i + 4))) { parts.push(cur); cur = ''; i += 3; continue; }
        }
        cur += ch;
    }
    parts.push(cur);
    const cleaned = parts.map((p) => cleanRole(p)).filter(Boolean);
    if (cleaned.length < 2) return [s];
    // Only split when every part is a role of its own; "Senior Java, C# and React engineers" is one role.
    if (!cleaned.every((p) => looksLikeRole(p) && ROLE_STRONG.test(p))) return [s];
    return cleaned;
}

/** "Role at Company", "First role +N more roles at Company", or the company alone. */
function titleOf(roles, company) {
    const at = company ? ` at ${company}` : '';
    const first = roles.length ? roles[0].replace(/^[a-z]/, (c) => c.toUpperCase()) : '';
    if (!roles.length) return company;
    if (roles.length === 1) return `${first}${at}`;
    return `${first} +${roles.length - 1} more role${roles.length - 1 === 1 ? '' : 's'}${at}`;
}

/**
 * A one-line job post → { company, title, location, remote, job_type, salary, tags, roles, line }.
 * company is '' when the line names none: the caller's thin-listing gate holds it.
 */
function parseHiringLine(line) {
    const original = clip(line, 500);
    const segments = String(line == null ? '' : line)
        .replace(/^[-–—*•\s]+/, '')
        .split(/\s*\|\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    const company = takeCompany(segments);

    const roles = [];
    const places = [];
    const typeLabels = [];
    const tags = [];
    let salary = null;
    let remote = false;
    let saidOnsite = false;
    let saidHybrid = false;
    let saidVisa = false;
    let noVisa = false;
    let saidAuth = false;
    let saidRelocation = false;

    for (const raw of segments) {
        let seg = stripUrls(raw);
        if (!seg) continue;
        // A pay segment (or the pay part of one) is the salary, and nothing else in it is a role.
        const pay = takePay(seg);
        if (pay) {
            salary = salary || pay.text;
            seg = pay.rest;
            if (!seg) continue;
        }
        const visaHere = VISA_RE.test(seg);
        const authHere = AUTH_RE.test(seg);
        const types = typesOf(seg);
        if (types.length) { for (const t of types) typeLabels.push(t); }
        if (REMOTE_RE.test(seg) && !NO_REMOTE_RE.test(seg)) remote = true;
        if (ONSITE_RE.test(seg)) saidOnsite = true;
        if (HYBRID_RE.test(seg)) saidHybrid = true;
        if (visaHere) { saidVisa = true; if (NO_VISA_RE.test(seg)) noVisa = true; }
        if (authHere) saidAuth = true;
        if (RELOCATION_RE.test(seg)) saidRelocation = true;

        // Remove the terms from the segment; what is left is a place or a role, or nothing.
        let rest = seg
            .replace(REMOTE_RE, ' ')
            .replace(NO_REMOTE_RE, ' ')
            .replace(ONSITE_RE, ' ')
            .replace(HYBRID_RE, ' ')
            .replace(VISA_RE, ' ')
            .replace(NO_VISA_RE, ' ')
            .replace(AUTH_RE, ' ')
            .replace(RELOCATION_RE, ' ')
            .replace(/\b(?:citizenship|authori[sz]ation|clearance|required|preferred|only)\b/gi, ' ')
            .replace(/\b(?:full[\s-]?time|part[\s-]?time|fulltime|parttime|permanent|temporary|internship|apprenticeship)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^[\s,;:/|.·•–—-]+|[\s,;:/|.·•–—-]+$/g, '')
            .trim();
        const place = (visaHere || authHere) ? null : (placeOf(seg) || placeOf(rest));
        if (place) {
            const known = places.some((p) => p.toLowerCase() === place.toLowerCase());
            const covered = /^remote$/i.test(place) && places.some((p) => /\bremote\b/i.test(p));
            if (!known && !covered) places.push(place);
        }
        // A segment that was nothing but terms, visa wording or pay is done (a bare "Remote" already went in as a place).
        if (letters(rest) < 2) continue;
        if (visaHere || authHere) {
            const residual = rest.replace(/[\s.,()/&-]*(?:u\.?s\.?a?|uk|eu)?[\s.,()/&-]*/gi, '').trim();
            if (letters(residual) < 2) continue;
        }
        let role = cleanRole(rest);
        // "Full-stack Engineer (Elixir) / Helsinki, Finland": the place is in the same segment as the role.
        if (role && place) {
            const parts = role.split(/\s+\/\s+/);
            const roleParts = parts.filter((p) => looksLikeRole(p));
            const placeParts = parts.filter((p) => !looksLikeRole(p) && placeOf(p));
            if (roleParts.length && placeParts.length) {
                role = roleParts.join(' / ');
                const combined = placeOf(placeParts.join(' / '));
                if (combined) {
                    const at = places.indexOf(place);
                    if (at >= 0) places[at] = combined;
                    else place = combined;
                }
            }
        }
        if (role && looksLikeRole(role) && (!place || ROLE_STRONG.test(role))) roles.push(...splitRoles(role));
    }

    // Terms, in the service's own existing fields: the workplace boolean, the type line and the chips.
    if (saidHybrid) tags.push('Hybrid');
    else if (saidOnsite) tags.push('Onsite');
    if (saidVisa) tags.push(noVisa ? 'No visa sponsorship' : 'Visa sponsorship');
    if (saidAuth) tags.push('Work authorization required');
    if (saidRelocation) tags.push('Relocation');
    const jobType = uniq(typeLabels).join(', ') || null;
    const title = titleOf(uniq(roles.map((r) => clip(r, 120))), company);

    return {
        company,
        title: clip(title, 240),
        location: uniq(places).join(' / ').slice(0, 200) || null,
        remote,
        job_type: jobType,
        salary: salary || null,
        tags: uniq(tags).slice(0, 6),
        roles: uniq(roles),
        line: original,
    };
}

module.exports = { parseHiringLine, hostOf, splitRoles, looksLikeRole, looksLikeCompany, titleOf, TITLE_RULE };
