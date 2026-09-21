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

test('all four row actions have a URL-disambiguated aria-label', () => {
  // v1.138.0 — the row actions moved into a ⋯ menu (menuItem(..., {
  // ariaLabel })), but the F-V54-B contract is unchanged: each
  // destructive/stateful action is named by a truncated URL.
  assert.match(PIPE,
    /ariaLabel:\s*t\('common\.delete', 'Delete'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'delete action missing aria-label with shortUrl(url)');
  assert.match(PIPE,
    /ariaLabel:\s*t\('pipe\.evaluateBtn'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'evaluate action missing aria-label with shortUrl(url)');
  assert.match(PIPE,
    /ariaLabel:\s*t\('pipe\.markDone', 'Done'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'done action missing aria-label with shortUrl(url)');
  assert.match(PIPE,
    /ariaLabel:\s*t\('pipe\.markSkip', 'Skip'\)\s*\+\s*': '\s*\+\s*shortUrl\(url\)/,
    'skip action missing aria-label with shortUrl(url)');
  // exactly the four row-action labels (no accidental over-application)
  const labels = PIPE.match(/ariaLabel:[^\n]*shortUrl\(url\)/g) || [];
  assert.equal(labels.length, 4, `expected 4 shortUrl aria-labels, got ${labels.length}`);
  // menuItem() must actually apply the option to the DOM node.
  assert.match(PIPE, /setAttribute\('aria-label', opts\.ariaLabel\)/,
    'menuItem must set the aria-label attribute it was given');
});

test('the ⋯ trigger is a named, state-announcing menu button', () => {
  assert.match(PIPE, /'aria-haspopup': 'menu'/, 'trigger must declare aria-haspopup=menu');
  assert.match(PIPE, /'aria-expanded': 'false'/, 'trigger must start collapsed');
  assert.match(PIPE, /setAttribute\('aria-expanded', 'true'\)/, 'opening must set aria-expanded');
  // Named by the row's role so N triggers don't collapse to N "button"s.
  assert.match(PIPE, /'aria-label': t\('track\.col\.actions', 'Actions'\) \+ ': ' \+ m\.role/);
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
