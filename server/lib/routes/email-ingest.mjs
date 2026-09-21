/**
 * Email-ingest run history — read-only view over the parent project's
 * data/email-ingest-runs.jsonl.
 *
 *   GET /api/email-ingest/runs?limit=N → { available, runs: Run[] }
 *
 * Fail-soft like /api/followup and /api/stats/lifetime: a parent project
 * without the instrumented ingest-email-labels.mjs reports
 * { available: false, runs: [] } instead of an error, so the view can say
 * "no runs recorded yet" rather than showing a failure.
 *
 * Read-only by design: triggering a sweep from the browser would mutate
 * Gmail (--mark-read) and write data/pipeline.md (via ingest-jobspy.mjs).
 * Those stay deliberate terminal actions.
 */
import { readEmailIngestRuns, runLogAvailable } from '../email-ingest-log.mjs';

export function registerEmailIngestRoutes(app) {
  app.get('/api/email-ingest/runs', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    res.json({ available: runLogAvailable(), runs: readEmailIngestRuns({ limit }) });
  });
}
