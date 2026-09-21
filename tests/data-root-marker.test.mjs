/**
 * `.career-ops-data` marker support.
 *
 * The parent resolves its user data through an env var, then a `.career-ops-data`
 * marker file in the checkout, then the checkout itself (AGENTS.md → "Path
 * Resolution Override"). web-ui honoured only CAREER_OPS_ROOT, so a checkout
 * whose data had been moved out resolved to the checkout anyway — and, since
 * such a checkout has no cv.md / portals.yml at all, it did not even match the
 * project-root probe and fell through to the `../` guess. The visible symptom
 * was an empty queue: `data/pipeline.md` read from the wrong directory.
 *
 * These tests bootstrap a split layout in a temp dir (CI-isolated — no parent
 * project, no network) and load paths.mjs via a dynamic import so the env is
 * set BEFORE the module resolves its roots at import time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Build a checkout + separate data dir joined by a marker.
 * `markerBody` is written verbatim so a relative path / blank marker can be
 * exercised too.
 */
function bootstrapSplit(markerBody, { dataDirName = 'the-data' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'co-marker-'));
  const repo = join(base, 'checkout');
  const data = join(base, dataDirName);

  // System layer — what stays behind in the checkout.
  mkdirSync(join(repo, 'templates'), { recursive: true });
  mkdirSync(join(repo, 'modes'), { recursive: true });
  writeFileSync(join(repo, 'templates', 'states.yml'), 'states: []\n');
  writeFileSync(join(repo, 'modes', '_shared.md'), '# shared\n');
  writeFileSync(join(repo, 'modes', 'oferta.md'), '# oferta\n');
  writeFileSync(join(repo, 'VERSION'), '1.0.0\n');

  // User layer — what moved out.
  mkdirSync(join(data, 'data'), { recursive: true });
  mkdirSync(join(data, 'modes'), { recursive: true });
  writeFileSync(join(data, 'cv.md'), '# cv\n');
  writeFileSync(join(data, 'portals.yml'), 'companies: []\n');
  writeFileSync(join(data, 'data', 'pipeline.md'), '```\nhttps://example.com/job/1\n```\n');
  writeFileSync(join(data, 'modes', '_custom.md'), '# custom\n');

  if (markerBody !== null) {
    writeFileSync(join(repo, '.career-ops-data'), markerBody);
  }
  return { base, repo, data };
}

/** Load a FRESH paths.mjs under the given env (resolution happens at import). */
async function loadPaths(env) {
  const saved = {};
  for (const k of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    // Cache-bust so each case re-resolves rather than reusing the first result.
    return await import(`../server/lib/paths.mjs?marker=${Math.random()}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Point the checkout at `repo` and let the marker inside it do the redirecting.
 *
 * CAREER_OPS_ROOT is used only to select the checkout — it is not a data-root
 * override — which is exactly the composition under test. (A no-env variant
 * can't be written from inside this repo: WEB_UI_ROOT is derived from the
 * module's own location, so the `../` candidate always finds the real checkout
 * before cwd is consulted.)
 */
const loadPathsFrom = (repo) =>
  loadPaths({ CAREER_OPS_ROOT: repo, CAREER_OPS_DATA_DIR: undefined });

test('an absolute marker moves the user layer and leaves the system layer put', async () => {
  const { base, repo, data } = bootstrapSplit(null);
  writeFileSync(join(repo, '.career-ops-data'), data);
  try {
    const m = await loadPathsFrom(repo);
    assert.equal(m.PROJECT_ROOT, repo);
    assert.equal(m.DATA_ROOT, data);
    // User layer follows the marker …
    assert.equal(m.PATHS.pipeline, join(data, 'data', 'pipeline.md'));
    assert.equal(m.PATHS.cv, join(data, 'cv.md'));
    assert.equal(m.PATHS.portals, join(data, 'portals.yml'));
    assert.equal(m.PATHS.profile, join(data, 'config', 'profile.yml'));
    // … the system layer does not, or every parent shell-out breaks.
    assert.equal(m.PATHS.version, join(repo, 'VERSION'));
    assert.equal(m.PATHS.statesYml, join(repo, 'templates', 'states.yml'));
    assert.equal(m.PATHS.batchRunner, join(repo, 'batch', 'batch-runner.sh'));
    assert.equal(m.PATHS.envFile, join(repo, '.env'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a marker path relative to the checkout resolves against it', async () => {
  const { base, repo, data } = bootstrapSplit(join('..', 'the-data'));
  try {
    const m = await loadPathsFrom(repo);
    assert.equal(m.DATA_ROOT, data);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('modePath prefers the user copy and falls back to the shipped one', async () => {
  const { base, repo, data } = bootstrapSplit(null);
  writeFileSync(join(repo, '.career-ops-data'), data);
  try {
    const m = await loadPathsFrom(repo);
    // _custom.md exists only under the data root.
    assert.equal(m.modePath('_custom.md'), join(data, 'modes', '_custom.md'));
    // oferta.md is shipped content and exists only in the checkout.
    assert.equal(m.modePath('oferta.md'), join(repo, 'modes', 'oferta.md'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('CAREER_OPS_DATA_DIR overrides a marker that points elsewhere', async () => {
  const { base, repo, data } = bootstrapSplit(null);
  writeFileSync(join(repo, '.career-ops-data'), data);
  const other = join(base, 'elsewhere');
  mkdirSync(other, { recursive: true });
  try {
    const m = await loadPaths({ CAREER_OPS_ROOT: repo, CAREER_OPS_DATA_DIR: other });
    assert.equal(m.DATA_ROOT, other);
    assert.notEqual(m.DATA_ROOT, data);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a relative CAREER_OPS_DATA_DIR resolves against the checkout, not cwd', async () => {
  // Resolving against cwd would split the data root away from the parent
  // shell-outs, which run with cwd = the checkout.
  const { base, repo, data } = bootstrapSplit(null);
  try {
    const m = await loadPaths({ CAREER_OPS_ROOT: repo, CAREER_OPS_DATA_DIR: join('..', 'the-data') });
    assert.equal(m.DATA_ROOT, data);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a marker pointing at a regular file is refused, not used as a root', async () => {
  const { base, repo, data } = bootstrapSplit(null);
  writeFileSync(join(repo, 'not-a-dir'), 'x');
  try {
    // Control: the SAME marker file pointing at a real directory is accepted,
    // proving the refusal below comes from the directory check and not from an
    // unreadable-marker fallback that would pass this test for the wrong reason.
    writeFileSync(join(repo, '.career-ops-data'), data);
    assert.equal((await loadPathsFrom(repo)).DATA_ROOT, data);

    writeFileSync(join(repo, '.career-ops-data'), 'not-a-dir');
    assert.equal((await loadPathsFrom(repo)).DATA_ROOT, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a CAREER_OPS_DATA_DIR that is not a directory fails at boot', async () => {
  const { base, repo, data } = bootstrapSplit(null);
  writeFileSync(join(repo, 'not-a-dir'), 'x');
  try {
    // Control: the env var IS plumbed through and a real directory is accepted,
    // so the rejections below are the directory check and not a dead knob.
    const ok = await loadPaths({ CAREER_OPS_ROOT: repo, CAREER_OPS_DATA_DIR: data });
    assert.equal(ok.DATA_ROOT, data);

    // A typo must not silently fall back to the checkout: the parent scripts
    // take the env var at its word, so the two would read different trees.
    for (const bad of ['not-a-dir', join('does', 'not', 'exist')]) {
      await assert.rejects(
        () => loadPaths({ CAREER_OPS_ROOT: repo, CAREER_OPS_DATA_DIR: bad }),
        /CAREER_OPS_DATA_DIR/,
        `expected a boot failure for ${bad}`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a blank or dangling marker falls back to the checkout, never to /', async () => {
  for (const body of ['', '   \n', join('does', 'not', 'exist')]) {
    const { base, repo } = bootstrapSplit(body);
    try {
      const m = await loadPaths({ CAREER_OPS_ROOT: repo });
      assert.equal(m.DATA_ROOT, repo, `marker body ${JSON.stringify(body)}`);
      assert.notEqual(m.DATA_ROOT, '/');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('with no marker the two roots coincide (single-directory layout unchanged)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'co-nomarker-'));
  mkdirSync(join(base, 'data'), { recursive: true });
  writeFileSync(join(base, 'cv.md'), '# cv\n');
  writeFileSync(join(base, 'portals.yml'), 'companies: []\n');
  try {
    const m = await loadPaths({ CAREER_OPS_ROOT: base });
    assert.equal(m.DATA_ROOT, m.PROJECT_ROOT);
    assert.equal(m.PATHS.pipeline, join(base, 'data', 'pipeline.md'));
    assert.equal(m.PATHS.version, join(base, 'VERSION'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a checkout whose data moved out is still recognized as the project root', async () => {
  // The regression: with no cv.md and no portals.yml, the old user-layer-only
  // probe matched nothing and resolution fell through to the `../` guess.
  const { base, repo } = bootstrapSplit(join('..', 'the-data'));
  const nested = join(repo, 'web-ui');
  mkdirSync(nested, { recursive: true });
  try {
    const m = await loadPaths({ CAREER_OPS_ROOT: repo });
    assert.equal(m.PROJECT_ROOT, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
