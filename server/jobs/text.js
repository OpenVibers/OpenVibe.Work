'use strict';

/**
 * The boards send a listing's description as HTML. We never republish it: we store a short plain-text excerpt and
 * link back to the listing for the rest. These are the two steps that make that safe — strip the markup, then cut on
 * a word boundary — and they are deliberately conservative: script and style content goes with the tags, and anything
 * that still looks like markup after the strip is removed rather than shown.
 */

const EXCERPT_CHARS = 300;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"', '#38': '&', '#60': '<', '#62': '>' };

function decode(text) {
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
        const key = body.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
        if (key[0] === '#') {
            const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
            // Only real, printable code points: a control character or a surrogate is not text anyone wrote.
            if (Number.isFinite(code) && code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
                try { return String.fromCodePoint(code); } catch { return ' '; }
            }
        }
        return ' ';
    });
}

/** The description as plain text: no tags, no script or style content, whitespace collapsed. */
function stripHtml(html) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // A script or style element's content is code, not prose; drop it with its tags.
    s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    // Block boundaries become a space so words either side do not run together.
    s = s.replace(/<\/?(br|p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|blockquote|pre|figure|hr)\b[^>]*>/gi, ' ');
    s = s.replace(/<[^>]*>/g, ' ');
    s = decode(s);
    // An unmatched '<' left by broken markup is not something a listing should show.
    s = s.replace(/<[^>]*$/g, ' ').replace(/[<>]/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

/** The excerpt: the first ~300 characters of the plain text, cut on a word, with a trailing ellipsis. */
function excerpt(html, max = EXCERPT_CHARS) {
    const text = stripHtml(html);
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const at = cut.lastIndexOf(' ');
    return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

module.exports = { stripHtml, excerpt, EXCERPT_CHARS };
