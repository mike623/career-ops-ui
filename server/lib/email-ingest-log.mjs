/**
 * Reader for the parent project's email-ingest run history.
 *
 * `ingest-email-labels.mjs` appends one JSON object per run to
 * data/email-ingest-runs.jsonl — start time, duration, status, the flags it
 * ran with, per-label counts, a template histogram, the mails whose template
 * it failed to recognize, and the ingest-jobspy exit code.
 *
 * Read-only: this file never writes the log. The parent owns it, and a user
 * whose parent project predates the instrumentation simply has no file —
 * callers get `available: false` rather than an error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { PATHS } from './paths.mjs';

const MAX_RUNS_RETURNED = 500;

/** True once the parent has run the instrumented script at least once. */
export function runLogAvailable() {
  return existsSync(PATHS.emailIngestRuns);
}

/**
 * Read run records, newest first. `limit` clamps the response; malformed
 * lines are skipped rather than failing the whole read, so a half-written
 * final line (killed mid-append) can't blank the view.
 */
export function readEmailIngestRuns({ limit = 50 } = {}) {
  if (!runLogAvailable()) return [];
  let lines;
  try {
    lines = readFileSync(PATHS.emailIngestRuns, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const cap = Math.min(MAX_RUNS_RETURNED, Math.max(1, Math.floor(limit) || 1));
  const out = [];
  // Walk backwards so a huge log costs only what we return, and so parse
  // failures near the tail don't push us short of `cap` usable records.
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    let run;
    try { run = JSON.parse(lines[i]); } catch { continue; }
    if (!run || typeof run !== 'object') continue;
    out.push(normalize(run));
  }
  return out;
}

/**
 * Fill in what an older or partial record may lack so the client can render
 * without defensive checks on every field.
 */
function normalize(run) {
  return {
    ts: typeof run.ts === 'string' ? run.ts : '',
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    status: typeof run.status === 'string' ? run.status : 'unknown',
    args: run.args && typeof run.args === 'object' ? run.args : {},
    csv: typeof run.csv === 'string' ? run.csv : '',
    rows: Number.isFinite(run.rows) ? run.rows : 0,
    labels: Array.isArray(run.labels) ? run.labels : [],
    templates: run.templates && typeof run.templates === 'object' ? run.templates : {},
    unrecognized: Array.isArray(run.unrecognized) ? run.unrecognized : [],
    ingestExit: Number.isFinite(run.ingestExit) ? run.ingestExit : null,
    error: typeof run.error === 'string' ? run.error : null,
  };
}
