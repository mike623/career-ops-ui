/**
 * Email-ingest run history (read-only view over the parent's
 * data/email-ingest-runs.jsonl, written by ingest-email-labels.mjs).
 *
 * CI-isolated: CAREER_OPS_ROOT points at a mktemp dir we populate ourselves,
 * so the test never reads the user's real job search. Every paths.mjs carrier
 * is imported dynamically inside before() — a static import would resolve
 * PROJECT_ROOT against the real parent before the env var is set (v1.69.2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server; let baseUrl; let root;
let readEmailIngestRuns; let runLogAvailable;

const LOG_LINES = [
  { ts: '2026-08-15T09:00:00.000Z', durationMs: 1200, status: 'completed', args: { limit: 25, dryRun: false }, csv: 'data/discovery-sweeps/email-labels-2026-08-15T09-00-00Z.csv', rows: 3, labels: [{ label: 'job/discovery/indeed', messages: 5, rows: 3, markedRead: 0 }], templates: { 'indeed-job-alert': 5 }, unrecognized: [], ingestExit: 0, error: null },
  { ts: '2026-08-16T09:00:00.000Z', durationMs: 61000, status: 'failed', args: { limit: 25 }, csv: '', rows: 0, labels: [], templates: {}, unrecognized: [], ingestExit: null, error: 'himalaya … failed (127)' },
  { ts: '2026-08-17T09:00:00.000Z', durationMs: 900, status: 'completed', args: { limit: 5, csvOnly: true }, csv: 'data/discovery-sweeps/email-labels-2026-08-17T09-00-00Z.csv', rows: 7, labels: [{ label: 'job/discovery/linkedin', messages: 5, rows: 7, markedRead: 2 }], templates: { 'linkedin-job-alert': 4, 'linkedin:unrecognized': 1 }, unrecognized: [{ label: 'job/discovery/linkedin', id: 41, subject: 'Your job alert' }], ingestExit: 0, error: null },
];

function writeLog(lines) {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'email-ingest-runs.jsonl'), lines.join('\n'), 'utf8');
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'email-ingest-root-'));
  process.env.CAREER_OPS_ROOT = root;
  // Make it look like a career-ops project so resolveProjectRoot() picks it.
  writeFileSync(join(root, 'cv.md'), '# CV\n', 'utf8');
  ({ readEmailIngestRuns, runLogAvailable } = await import('../server/lib/email-ingest-log.mjs'));
  const { createApp } = await import('../server/index.mjs');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(() => {
  delete process.env.CAREER_OPS_ROOT;
  rmSync(root, { recursive: true, force: true });
  return new Promise((r) => server.close(r));
});

test('no log file → unavailable, empty list, and the route still answers 200', async () => {
  rmSync(join(root, 'data', 'email-ingest-runs.jsonl'), { force: true });
  assert.equal(runLogAvailable(), false);
  assert.deepEqual(readEmailIngestRuns(), []);

  const r = await fetch(`${baseUrl}/api/email-ingest/runs`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { available: false, runs: [] });
});

test('runs come back newest-first with their per-run detail intact', () => {
  writeLog(LOG_LINES.map((l) => JSON.stringify(l)));
  const runs = readEmailIngestRuns();
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => r.ts), [
    '2026-08-17T09:00:00.000Z', '2026-08-16T09:00:00.000Z', '2026-08-15T09:00:00.000Z',
  ]);
  assert.equal(runs[0].rows, 7);
  assert.equal(runs[0].labels[0].markedRead, 2);
  assert.deepEqual(runs[0].templates, { 'linkedin-job-alert': 4, 'linkedin:unrecognized': 1 });
  assert.equal(runs[0].unrecognized[0].subject, 'Your job alert');
  // A crashed sweep keeps its error and reports no ingest exit code.
  assert.equal(runs[1].status, 'failed');
  assert.match(runs[1].error, /127/);
  assert.equal(runs[1].ingestExit, null);
});

test('limit clamps to the newest N and is bounded on both ends', () => {
  writeLog(LOG_LINES.map((l) => JSON.stringify(l)));
  assert.deepEqual(readEmailIngestRuns({ limit: 1 }).map((r) => r.ts), ['2026-08-17T09:00:00.000Z']);
  // Nonsense limits must not empty the list or blow past the internal cap.
  assert.equal(readEmailIngestRuns({ limit: 0 }).length, 1);
  assert.equal(readEmailIngestRuns({ limit: -5 }).length, 1);
  assert.equal(readEmailIngestRuns({ limit: 99999 }).length, 3);
});

test('a malformed line is skipped, not fatal — a kill mid-append can leave one', () => {
  writeLog([
    JSON.stringify(LOG_LINES[0]),
    '{"ts":"2026-08-16T09:00:00.000Z","status":"comp',   // truncated write
    'null',                                              // parses, but not a record
    JSON.stringify(LOG_LINES[2]),
  ]);
  const runs = readEmailIngestRuns();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.status), ['completed', 'completed']);
});

test('a record from an older writer is normalized rather than rejected', () => {
  writeLog([JSON.stringify({ ts: '2026-08-10T09:00:00.000Z', status: 'completed' })]);
  const [run] = readEmailIngestRuns();
  assert.deepEqual(run.labels, []);
  assert.deepEqual(run.templates, {});
  assert.deepEqual(run.unrecognized, []);
  assert.equal(run.rows, 0);
  assert.equal(run.durationMs, null);
  assert.equal(run.ingestExit, null);
});

test('GET /api/email-ingest/runs reports availability and honours ?limit', async () => {
  writeLog(LOG_LINES.map((l) => JSON.stringify(l)));
  const r = await fetch(`${baseUrl}/api/email-ingest/runs?limit=2`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.available, true);
  assert.equal(j.runs.length, 2);
  assert.equal(j.runs[0].ts, '2026-08-17T09:00:00.000Z');
  assert.equal(j.runs[0].csv, 'data/discovery-sweeps/email-labels-2026-08-17T09-00-00Z.csv');
});
