import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __d = dirname(fileURLToPath(import.meta.url));
const PIPE = readFileSync(resolve(__d, '..', 'public', 'js', 'views', 'pipeline.js'), 'utf8');

test('pipeline filter searches item.text, not only the URL', () => {
  assert.match(PIPE, /let allItems = \[\]/, 'pipeline state must keep API item metadata');
  assert.match(PIPE, /allItems\.filter\(\(item\) => \(item\.text \|\| item\.url \|\| ''\)\.toLowerCase\(\)\.includes\(q\)\)/,
    'filter must search the full pipeline row text');
});

test('pipeline API response keeps backward-compatible url fallback', () => {
  assert.match(PIPE, /fresh\.items \|\| allUrls\.map\(\(url\) => \(\{ url, text: url \}\)\)/,
    'refresh path must fall back to URL-only API responses');
  assert.match(PIPE, /initial\.items \|\| allUrls\.map\(\(url\) => \(\{ url, text: url \}\)\)/,
    'initial path must fall back to URL-only API responses');
});
