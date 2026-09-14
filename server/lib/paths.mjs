import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// __dirname is .../server/lib  →  go up twice to repo root
export const WEB_UI_ROOT = resolve(__dirname, '..', '..');
export const PUBLIC_DIR = resolve(WEB_UI_ROOT, 'public');

/** The marker file the parent uses to point its user data somewhere else. */
const DATA_MARKER = '.career-ops-data';

/** A checkout carries the user's data (cv.md / portals.yml) … */
const hasUserLayer = (d) =>
  existsSync(resolve(d, 'cv.md')) || existsSync(resolve(d, 'portals.yml'));

/** … or, when the data lives elsewhere, only the system layer stays behind. */
const hasSystemLayer = (d) =>
  existsSync(resolve(d, DATA_MARKER)) ||
  existsSync(resolve(d, 'templates', 'states.yml')) ||
  existsSync(resolve(d, 'modes', '_shared.md'));

/**
 * Resolve where the career-ops CHECKOUT lives — the system layer: the parent's
 * `*.mjs` scripts (every shell-out's cwd), `templates/`, `modes/_shared.md`,
 * `batch/`, `VERSION`, `.env`.
 *
 *   1. CAREER_OPS_ROOT env var (absolute, or relative to cwd — unlike
 *      CAREER_OPS_DATA_DIR, which is relative to the checkout; this one names
 *      the checkout, so there is no root to resolve it against yet)
 *   2. ../  (when this repo is dropped in as career-ops/web-ui)
 *   3. cwd  (when launched from inside career-ops itself)
 *
 * A candidate is recognized by its user layer OR its system layer. Checking the
 * system layer matters when the user data has been moved out via the marker:
 * such a checkout has no cv.md / portals.yml at all, so the user-layer test
 * alone matched nothing and every path fell through to the `../` guess.
 * If none match, default to ../ and let the user notice via the Health page.
 */
function resolveProjectRoot() {
  const candidates = [];
  if (process.env.CAREER_OPS_ROOT) {
    candidates.push(resolve(process.cwd(), process.env.CAREER_OPS_ROOT));
  }
  candidates.push(resolve(WEB_UI_ROOT, '..'));     // career-ops/web-ui case
  candidates.push(process.cwd());                  // launched from inside career-ops

  for (const c of candidates) {
    if (hasUserLayer(c) || hasSystemLayer(c)) return c;
  }
  return candidates[0] ?? candidates[1];
}

export const PROJECT_ROOT = resolveProjectRoot();

/**
 * Resolve where the USER LAYER lives — `cv.md`, `config/`, `data/`, `reports/`,
 * `jds/`, `output/`, `interview-prep/`, `networking/`, `modes/_profile.md`.
 *
 * Mirrors the parent's own precedence (AGENTS.md → "Path Resolution Override"):
 *   1. CAREER_OPS_DATA_DIR env var — names the data directory outright
 *   2. a `.career-ops-data` marker in the checkout, holding a path (absolute,
 *      or relative to the checkout)
 *   3. the checkout itself
 *
 * CAREER_OPS_ROOT is deliberately NOT a data-root override: it names the
 * checkout, and a marker inside that checkout is the checkout's own statement
 * about where its data lives, so the two compose rather than conflict. Point
 * CAREER_OPS_DATA_DIR at a directory to override the marker.
 *
 * Without a marker or env var this returns PROJECT_ROOT, so the single-directory
 * layout — and every test that bootstraps one — behaves exactly as before.
 */
/**
 * Accept `target` as a data root, or return null.
 *
 * Both inputs (env var, marker body) get the same treatment: an empty value
 * means "no redirect" rather than "resolve to /", relative paths resolve
 * against the CHECKOUT rather than cwd, and the result must be a directory —
 * a path naming a regular file would otherwise become a root that every
 * subsequent path is joined onto.
 *
 * Relative-against-the-checkout matters because the parent resolves its own
 * override that way, and the parent scripts we shell out to run with
 * cwd = repoRoot. Resolving against cwd would make `npm start` from `web-ui/`
 * choose a different directory than those scripts do: a silent split brain.
 */
function acceptDataRoot(repoRoot, target) {
  if (!target || !target.trim()) return null;
  const dataRoot = resolve(repoRoot, target.trim());
  try {
    return statSync(dataRoot).isDirectory() ? dataRoot : null;
  } catch {
    return null; // missing, unreadable, or not a directory
  }
}

function resolveDataRoot(repoRoot) {
  // An env var is an operator who just typed a path. If it does not name a
  // directory, that is a typo, and falling back to the checkout would read a
  // DIFFERENT directory than the parent scripts (which take the env var at its
  // word) — the silent split brain this whole function exists to prevent. Fail
  // at boot instead, where the message is unmissable.
  const envTarget = process.env.CAREER_OPS_DATA_DIR;
  if (envTarget && envTarget.trim()) {
    const fromEnv = acceptDataRoot(repoRoot, envTarget);
    if (!fromEnv) {
      throw new Error(
        `CAREER_OPS_DATA_DIR is set to "${envTarget}" but that is not a directory ` +
        `(resolved against ${repoRoot}). Fix the path or unset it.`,
      );
    }
    return fromEnv;
  }

  // A marker is checkout state, not something just typed — it can arrive by
  // clone, naming a path that exists on someone else's machine. Fall back to
  // the checkout rather than refuse to boot; #/health reports the root in use.
  const marker = resolve(repoRoot, DATA_MARKER);
  try {
    if (statSync(marker).isFile()) {
      const fromMarker = acceptDataRoot(repoRoot, readFileSync(marker, 'utf8'));
      if (fromMarker) return fromMarker;
    }
  } catch {
    // Marker missing, unreadable, or itself a directory — use the checkout.
  }
  return repoRoot;
}

export const DATA_ROOT = resolveDataRoot(PROJECT_ROOT);

/** Resolve a USER-LAYER path (cv.md, data/, reports/, config/, …). */
export const path = (...segments) => resolve(DATA_ROOT, ...segments);

/** Resolve a SYSTEM-LAYER path (parent scripts, templates/, batch/, VERSION). */
export const repoPath = (...segments) => resolve(PROJECT_ROOT, ...segments);

/**
 * Resolve a file under `modes/`, which straddles the two layers: `_profile.md`
 * and `_custom.md` are the user's (and move with the data root), every other
 * mode is shipped system content that stays in the checkout. Rather than make
 * each caller know which is which, prefer the data root when the file is
 * actually there and fall back to the checkout. Collapses to the checkout when
 * the two roots are the same.
 */
export const modePath = (name) => {
  const inData = resolve(DATA_ROOT, 'modes', name);
  return existsSync(inData) ? inData : resolve(PROJECT_ROOT, 'modes', name);
};

export const PATHS = {
  root: PROJECT_ROOT,
  applications: path('data', 'applications.md'),
  pipeline: path('data', 'pipeline.md'),
  scanHistory: path('data', 'scan-history.tsv'),
  followUps: path('data', 'follow-ups.md'),
  activityLog: path('data', 'activity.jsonl'),
  roleStats: path('data', 'role-stats.jsonl'),
  llmUsage: path('data', 'llm-usage.jsonl'),
  // Written by the parent's ingest-email-labels.mjs, one JSON line per sweep.
  // Read-only here — see lib/email-ingest-log.mjs.
  emailIngestRuns: path('data', 'email-ingest-runs.jsonl'),
  reportsDir: path('reports'),
  jdsDir: path('jds'),
  outputDir: path('output'),
  // The SHIPPED modes, which stay in the checkout. Deliberately not the same
  // root as `modesProfile` below — `modes/` straddles the layer boundary; see
  // modePath(). GET /api/modes lists the union of the two directories.
  modesDir: repoPath('modes'),
  // G-008 (v1.15.0) — `modes/_profile.md` is the canonical "Career framing"
  // file per career-ops.org/docs/.../what-is-career-ops §Step-5. It holds
  // target roles, framing, exit narrative, comp targets, location policy.
  // Never committed (.gitignore in parent). Surfaced via the new
  // #/config → Modes tab and a read-only card on #/profile.
  modesProfile: path('modes', '_profile.md'),
  modesProfileTemplate: repoPath('modes', '_profile.template.md'),
  interviewPrepDir: path('interview-prep'),
  // v1.90.0 (Epic 15) — the candidate's own STAR+R story bank, inlined into
  // the mock-interview prompt (same trust level as cv.md per DATA_CONTRACT).
  storyBank: path('interview-prep', 'story-bank.md'),
  // v1.91.0 (Epic 16) — saved networking plans (who-to-contact + outreach
  // drafts + company dossier), written only on explicit user Save.
  networkingDir: path('networking'),
  // v1.13.0 — batch evaluate flow (canonical career-ops.org guide §4).
  batchDir: repoPath('batch'),
  batchInput: repoPath('batch', 'batch-input.tsv'),
  batchRunner: repoPath('batch', 'batch-runner.sh'),
  batchAdditionsDir: repoPath('batch', 'tracker-additions'),
  cv: path('cv.md'),
  // v1.92.0 (Epic 21 — CV Studio) — voice/style source of truth for the
  // "make it human / match my voice" rewrite. Both are in-scope per the
  // DATA_CONTRACT (voice-dna governs HOW text reads; writing-samples are the
  // user's own prose). Never introduce new factual claims from them.
  voiceDna: path('voice-dna.md'),
  writingSamplesDir: path('writing-samples'),
  profile: path('config', 'profile.yml'),
  twoPager: path('config', 'two-pager.yml'),
  // v1.93.0 (Epic 24 — memory layer) — a short, USER-EDITABLE "remember this
  // about me" note (behavioural steering + preferences, never fabricated
  // content). Inlined into bundleProjectContext so it reaches every AI request
  // across all providers. User layer; never overwritten by system updates.
  memory: path('config', 'memory.md'),
  // v1.95.0 (Epic 26 — career plan) — a personalized AI-generated career
  // development plan (roadmap, SMART/OKR goals, skill plan). Saved to the user
  // layer on explicit Save; never overwritten by system updates.
  careerPlan: path('config', 'career-plan.md'),
  portals: path('portals.yml'),
  // v1.128.0 — the canonical application-state definitions
  // (id/label/aliases/dashboard_group). System layer, read-only; the tracker
  // reads it live instead of hardcoding a status whitelist (see
  // server/lib/states.mjs). A hardcoded fallback covers CI isolation.
  statesYml: repoPath('templates', 'states.yml'),
  packageJson: repoPath('package.json'),
  version: repoPath('VERSION'),
  envFile: repoPath('.env'),
};
