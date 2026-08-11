/**
 * v1.54.4 — F-V54-B (regression run): the #/pipeline per-row action
 * buttons were icon-only (▶ evaluate / ✕ delete) with only a `title`
 * attribute. `title` is not a reliable accessible name (WCAG 4.1.2
 * Name, Role, Value), so a screen-reader user heard N indistinct
 * "button"s — and could not tell which row a delete would hit. Both
 * buttons now carry an explicit `aria-label` disambiguated by a
 * compact URL (shortUrl(): host + last path segments).
 *
 * Browser-only view → asserted statically (router.test.mjs style),
 * with the shortUrl transform re-derived so its disambiguation
 * contract is locked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPE = readFileSync(
  resolve(__dirname, '..', 'public', 'js', 'views', 'pipeline.js'), 'utf8');

test('both row-action buttons have a URL-disambiguated aria-label', () => {
  // delete button: aria-label = Delete + shortUrl(url)
  assert.match(PIPE,
    /'aria-label':\s*t\('common\.delete', 'Delete'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'delete button missing aria-label with shortUrl(url)');
  // evaluate button: aria-label = evaluateBtn + shortUrl(url)
  assert.match(PIPE,
    /'aria-label':\s*t\('pipe\.evaluateBtn'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'evaluate button missing aria-label with shortUrl(url)');
  // done / skip buttons (mark a queued URL `- [x]` / `- [!]`)
  assert.match(PIPE,
    /'aria-label':\s*t\('pipe\.markDone', 'Done'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'done button missing aria-label with shortUrl(url)');
  assert.match(PIPE,
    /'aria-label':\s*t\('pipe\.markSkip', 'Skip'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'skip button missing aria-label with shortUrl(url)');
  // exactly the four row-action labels (no accidental over-application)
  const labels = PIPE.match(/'aria-label':[^\n]*shortUrl\(url\)/g) || [];
  assert.equal(labels.length, 4, `expected 4 shortUrl aria-labels, got ${labels.length}`);
});

test('shortUrl is defined before the row builder uses it', () => {
  assert.match(PIPE, /function shortUrl\(u\)\s*\{/, 'shortUrl() not defined');
  assert.ok(PIPE.indexOf('function shortUrl') < PIPE.indexOf('shortUrl(url)'),
    'shortUrl must be declared before its first use');
});

// ── Re-derived shortUrl (mirrors pipeline.js) — proves rows disambiguate ──
function shortUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    const segs = pathname.split('/').filter(Boolean);
    const tail = segs.slice(-2).join('/');
    return tail ? `${hostname}/…/${tail}` : hostname;
  } catch {
    const s = String(u || '');
    return s.length > 48 ? '…' + s.slice(-47) : s;
  }
}

test('shortUrl disambiguates two jobs on the same board', () => {
  const a = shortUrl('https://hh.ru/vacancy/12345');
  const b = shortUrl('https://hh.ru/vacancy/98765');
  assert.notEqual(a, b, 'same-host different-job URLs must not collapse');
  assert.equal(a, 'hh.ru/…/vacancy/12345');
});

test('shortUrl: bare host, and unparseable input fallback', () => {
  assert.equal(shortUrl('https://example.com'), 'example.com');
  assert.equal(shortUrl('not a url'), 'not a url');
  const long = 'x'.repeat(80);
  assert.equal(shortUrl(long), '…' + long.slice(-47));
  assert.equal(shortUrl(''), '');
});
