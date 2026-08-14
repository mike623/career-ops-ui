/**
 * v1.55.7 — UX-7 (first-run / cognitive load + perf): #/pipeline
 * rendered EVERY row (filtered.forEach(appendChild)). A real scan
 * fills the pipeline with 1000s of URLs → 1000s of row nodes (each a
 * flex div + an <a> + two buttons) built synchronously on every
 * filter keystroke. Virtualize: above a threshold, render only the
 * scroll viewport ± a small buffer (a vanilla-JS react-window).
 *
 * Contract (locked here so it can't silently regress):
 *   • a numeric VIRTUALIZE_THRESHOLD (≈1000) gates the behaviour;
 *   • ≤ threshold → the original simple full render (zero behaviour
 *     change for typical pipelines — existing tests/e2e stay valid);
 *   • > threshold → a sized spacer preserves scrollbar height, a
 *     scroll listener re-renders a windowed slice (slice(start,end)),
 *     rows keep their URL-disambiguated ▶ / ✕ aria-labels;
 *   • the pure window math is a testable helper.
 *
 * pipeline.js is a browser IIFE → asserted statically
 * (router.test.mjs / scan-advanced-disclosure.test.mjs style).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __d = dirname(fileURLToPath(import.meta.url));
const PIPE = readFileSync(resolve(__d, '..', 'public', 'js', 'views', 'pipeline.js'), 'utf8');

test('a numeric virtualization threshold (~1000) gates the path', () => {
  const m = PIPE.match(/VIRTUALIZE_THRESHOLD\s*=\s*(\d+)/);
  assert.ok(m, 'VIRTUALIZE_THRESHOLD constant must exist');
  const n = Number(m[1]);
  assert.ok(n >= 500 && n <= 2000, `threshold ${n} should be ~1000`);
});

test('small lists keep the original simple full render', () => {
  // The non-virtual branch must still forEach→appendChild every row
  // so typical pipelines (and the existing pipeline tests) are
  // byte-for-byte unaffected.
  assert.match(PIPE, /forEach\(\(u\) => list\.appendChild\(urlRow\(u\)\)\)/,
    'the ≤threshold path must keep the simple forEach render');
});

test('large lists render a windowed slice with a scroll listener', () => {
  assert.match(PIPE, /\.slice\(\s*\w+\s*,\s*\w+\s*\)/,
    'the virtual path must render filtered.slice(start, end)');
  assert.match(PIPE, /addEventListener\('scroll'/,
    'a scroll listener must drive the window');
  assert.match(PIPE, /requestAnimationFrame|rAF/,
    'scroll re-render should be rAF-throttled');
  assert.match(PIPE, /spacer|totalHeight|scrollHeight/i,
    'a spacer must preserve the scrollbar height');
});

test('pure window math helper exists and is sane', () => {
  // computeWindow(scrollTop,rowH,total,viewportH,buffer)→{start,end}
  const m = PIPE.match(/function computeWindow\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(m, 'a pure computeWindow() helper must exist');
  const body = m[0];
  assert.match(body, /Math\.max\(\s*0/, 'start must clamp at 0');
  assert.match(body, /Math\.min/, 'end must clamp at total');
  assert.match(body, /buffer/, 'window must include a ± buffer');
});

test('virtualized rows keep their disambiguated action aria-labels', () => {
  // urlRow() (shared by both paths) must still expose the
  // aria-labelled ▶ / ✕ actions — regression lock on F-V54-B.
  // v1.138.0 — the actions live in the shared ⋯ row menu; the labels
  // are passed as menuItem() options and applied via setAttribute.
  assert.match(PIPE, /ariaLabel: t\('pipe\.evaluateBtn'\) \+ ': ' \+ shortUrl\(url\)/);
  assert.match(PIPE, /ariaLabel: t\('common\.delete', 'Delete'\) \+ ': ' \+ shortUrl\(url\)/);
});
