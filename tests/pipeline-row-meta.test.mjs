/**
 * v1.138.0 — the #/pipeline queue became a data grid, so the row cells
 * are now PARSED from `data/pipeline.md` lines rather than shown raw:
 *
 *   - [ ] <url> | Company | Role [| Location | Comp | note: … | posted: …]
 *
 * Columns 3+ are free-form (modes/pipeline.md), so they're classified
 * by SHAPE, not position, and anything unrecognized falls through to
 * Notes so nothing in the user's file is silently dropped.
 *
 * pipeline.js is a browser IIFE with no exports, so the pure helpers
 * are lifted out of the source and evaluated in a vm — same spirit as
 * the other source-static pipeline tests, but asserting behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __d = dirname(fileURLToPath(import.meta.url));
const PIPE = readFileSync(resolve(__d, '..', 'public', 'js', 'views', 'pipeline.js'), 'utf8');

/** Lift `const NAME = …;` / `function NAME(…) {…}` out of the IIFE. */
function lift(name) {
  const start = PIPE.search(new RegExp(`^  (?:const ${name}\\b|function ${name}\\()`, 'm'));
  assert.ok(start >= 0, `${name} must exist in pipeline.js`);
  // Balance braces/parens from the declaration to its end.
  let depth = 0, i = start, seen = false;
  for (; i < PIPE.length; i++) {
    const ch = PIPE[i];
    if (ch === '{' || ch === '(') { depth++; seen = true; }
    else if (ch === '}' || ch === ')') { depth--; }
    else if (ch === ';' && depth === 0 && seen) { i++; break; }
    if (seen && depth === 0 && ch === '}') { i++; break; }
  }
  return PIPE.slice(start, i);
}

const sandbox = vm.createContext({});
vm.runInContext(
  [lift('COMP_RE'), lift('NUM_ONLY_RE'), lift('classifyCells'), lift('prettySlug')].join('\n'),
  sandbox,
);
const classifyCells = vm.runInContext('classifyCells', sandbox);
const prettySlug = vm.runInContext('prettySlug', sandbox);

test('free-form cells land in the right columns', () => {
  const out = classifyCells(['Berlin', '120k–140k EUR', 'posted: 2026-08-01', 'note: referral']);
  assert.equal(out.location, 'Berlin');
  assert.equal(out.comp, '120k–140k EUR');
  assert.equal(out.posted, '2026-08-01');
  assert.equal(out.notes.join(' | '), 'referral');
});

test('a bare ISO date is the posted column wherever it sits', () => {
  assert.equal(classifyCells(['2026-08-01', 'Remote']).posted, '2026-08-01');
  assert.equal(classifyCells(['2026-08-01', 'Remote']).location, 'Remote');
});

test('unrecognized cells fall through to notes — nothing is dropped', () => {
  const out = classifyCells(['Remote', 'via Hays', 'contract']);
  assert.equal(out.location, 'Remote');
  assert.equal(out.notes.join(' | '), 'via Hays | contract'); // vm realm: compare by value
});

test('req/posting IDs are NOT mistaken for compensation', () => {
  // A bare 4+ digit run inside an ID used to win the Comp column ahead
  // of the Location fallback (`JR-10423` → Comp). Money needs a money
  // signal; a number-only cell still counts.
  for (const id of ['JR-10423', 'req 88214', 'R_2291']) {
    assert.equal(classifyCells([id]).comp, '', `${id} must not be Comp`);
  }
  assert.equal(classifyCells(['120000']).comp, '120000');
  assert.equal(classifyCells(['$150,000']).comp, '$150,000');
});

test('prettySlug keeps a numeric posting tail readable', () => {
  assert.equal(prettySlug('https://boards.example.com/jobs/posting/123'), 'posting 123');
  assert.match(prettySlug('https://example.com/careers/senior-backend-engineer'),
    /senior backend engineer/);
});
