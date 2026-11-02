'use strict';
// A folded part says how much it holds on its line (the owner's rule: folds show their count), as on every other site.
const assert = require('assert');
const { foldBlock } = require('../server/render/short');
const faq = foldBlock({ id: 'faq', bare: true, head: '<h2>Questions people ask</h2>', html: '<details><summary>a</summary></details><details><summary>b</summary></details><details><summary>c</summary></details>' });
assert.ok(faq.includes('<h2>Questions people ask</h2><span class="fold-n">3 questions</span><span class="fold-mark"'), faq);
const list = foldBlock({ id: 'net', head: '<h2>Part of OpenVibe</h2>', html: '<ul><li>a</li><li>b</li></ul>' });
assert.ok(list.includes('<span class="fold-n">2 items</span>'), 'items');
const shipped = foldBlock({ id: 's', head: '<h2>Recently shipped</h2>', html: '<ol data-ov-shipped="list" data-limit="5"><li>x</li></ol>' });
assert.ok(shipped.includes('<span class="fold-n">latest 5</span>'), 'the shipped list says how many it shows');
assert.ok(!foldBlock({ id: 'e', head: '<h2>x</h2>', html: '<p>one</p>' }).includes('fold-n'), 'nothing to count, no count');
console.log('fold-counts: all passed');
