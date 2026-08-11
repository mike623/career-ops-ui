/**
 * Markdown / data-file parsers for career-ops.
 * Pure functions — no I/O. Input: string. Output: structured object.
 * Heavily tested in tests/parsers.test.mjs.
 */

/**
 * Split `s` on `delim` but ignore occurrences preceded by a backslash.
 * Used by parseMarkdownTable so `\|` inside a cell stays inside the cell.
 */
function splitUnescaped(s, delim) {
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === delim) {
      buf += '\\' + delim;
      i += 1;
      continue;
    }
    if (c === delim) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/**
 * Parse a markdown table (GFM). Returns { headers: string[], rows: string[][] }.
 * Empty input or no table → { headers: [], rows: [] }.
 */
export function parseMarkdownTable(text) {
  if (!text) return { headers: [], rows: [] };
  const lines = text.split('\n');
  let headers = [];
  const rows = [];
  let inTable = false;
  let separatorSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (inTable) break; // table ended
      continue;
    }
    // BF-1 — split on unescaped `|` only. GFM lets writers escape a
    // literal pipe inside a cell as `\|`; without this, a company name
    // like "Acme | Co" would explode into two cells and corrupt the
    // table parse. Restore the literal `|` after splitting.
    const cells = splitUnescaped(line, '|')
      .slice(1, -1)
      .map((c) => c.replace(/\\\|/g, '|').trim());

    if (!inTable) {
      headers = cells;
      inTable = true;
      continue;
    }

    if (!separatorSeen) {
      // separator row like |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        separatorSeen = true;
        continue;
      }
      // not a real table — abort
      return { headers: [], rows: [] };
    }

    rows.push(cells);
  }

  return { headers, rows };
}

/**
 * Parse applications.md → array of objects keyed by lowercased headers.
 * Adds .reportPath if a `[\d+](reports/...)` link is present in the Report cell.
 */
export function parseApplications(text) {
  const { headers, rows } = parseMarkdownTable(text);
  if (!headers.length) return [];
  const keys = headers.map((h) => h.replace(/^#/, 'num').toLowerCase().trim());

  return rows.map((cells) => {
    const obj = {};
    keys.forEach((k, i) => {
      obj[k] = cells[i] ?? '';
    });

    // Extract score number
    if (obj.score) {
      const m = obj.score.match(/([\d.]+)/);
      obj.scoreNum = m ? parseFloat(m[1]) : null;
    }

    // Extract report path
    if (obj.report) {
      const m = obj.report.match(/\(([^)]+)\)/);
      obj.reportPath = m ? m[1] : null;
    }

    obj.pdfReady = obj.pdf?.includes('✅') || false;
    return obj;
  });
}

const PENDING_HEADING_RE = /^##[ \t]+(Pending|Pendientes)[ \t]*$/mi;

/**
 * Locate the pending region of pipeline.md.
 *
 * Two formats exist in the wild:
 *   - Parent CLI format (scan.mjs, modes/pipeline.md): a `## Pending` /
 *     `## Pendientes` section of `- [ ] {url} | Company | Role | …` rows,
 *     followed by `## Processed` / `## Procesadas`.
 *   - Legacy web-ui format: a bare ```fence``` of one URL per line.
 *
 * Returns { block, start, end } — offsets into `text` for the region so the
 * writers can splice without reformatting the rest of the file.
 */
function pendingRegion(text) {
  const heading = text.match(PENDING_HEADING_RE);
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const next = rest.search(/^## /m);
    const end = next === -1 ? text.length : start + next;
    return { block: text.slice(start, end), start, end, cli: true };
  }
  const fence = text.match(/```([\s\S]*?)```/);
  if (fence) {
    const start = fence.index + 3;
    return { block: fence[1], start, end: start + fence[1].length, cli: false };
  }
  return { block: text, start: 0, end: text.length, cli: false };
}

/** `- [ ] https://…` → `https://…`; done `[x]` / skipped `[!]` rows → ''. */
function pipelineUrlOf(line) {
  const l = line.trim().replace(/^-\s+\[ \]\s*/, '');
  if (l.startsWith('- [')) return ''; // `- [x]` processed row
  // v1.84.0 (#1017) — a line may carry an optional `| <compensation>` column;
  // the URL is the first ` | `-delimited token. Bare URLs are unaffected.
  const u = l.split(/\s+\|\s+/)[0].trim();
  return u.startsWith('http') || u.startsWith('local:') ? u : '';
}

function pipelineItemOf(line) {
  const url = pipelineUrlOf(line);
  if (!url) return null;
  return { url, text: line.trim() };
}

/**
 * Parse pipeline.md → list of pending URLs.
 * Reads the `## Pending` section (parent CLI format) when present, otherwise
 * the first ```code-fence``` block (legacy web-ui format).
 */
export function parsePipeline(text) {
  if (!text) return [];
  return pendingRegion(text).block.split('\n').map(pipelineUrlOf).filter(Boolean);
}

/**
 * Parse pipeline.md → pending row metadata for UI filtering.
 * `url` preserves the existing API contract; `text` preserves the whole row so
 * the Pipeline page can search company/role/location/notes columns too.
 */
export function parsePipelineItems(text) {
  if (!text) return [];
  return pendingRegion(text).block.split('\n').map(pipelineItemOf).filter(Boolean);
}

/**
 * Cheap default validator (REVIEW-C4). Route handlers gate inputs with
 * `isValidJobUrl` from server/index.mjs; this is the parser-level
 * defense-in-depth so future callers (CLI utilities, batch importers,
 * scanners) can't accidentally pump a `javascript:` URL into pipeline.md.
 */
function defaultUrlGate(s) {
  if (typeof s !== 'string') return false;
  return /^https?:\/\//i.test(s);
}

/**
 * Sanitize an optional compensation cell for pipeline.md (#1017). Collapses
 * newlines / tabs / pipes (which would inject a column or row), trims, and
 * neutralizes a spreadsheet-formula-leading char. Returns '' when empty.
 */
function sanitizePipelineComp(v) {
  if (typeof v !== 'string') return '';
  // Collapse injection chars (newline / tab / pipe), then hard-cap the cell to
  // 80 chars TOTAL. For a formula-lead (= + - @) reserve one char for the
  // neutralizing quote so the quoted cell still fits in 80 (never 81).
  const s = v.replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^[=+\-@]/.test(s)) return `'${s.slice(0, 79)}`;
  return s.slice(0, 80);
}

/**
 * Add a URL to pipeline.md content. Returns updated content.
 * Preserves existing fence (and any existing `| comp` columns); creates one if missing.
 *
 * Optional `opts.validate` overrides the default `https?://` gate.
 * Optional `opts.comp` appends a sanitized compensation column (`url | comp`).
 */
export function addPipelineUrl(text, url, opts = {}) {
  const trimmed = (url || '').trim();
  if (!trimmed) return text;
  const validate = typeof opts.validate === 'function' ? opts.validate : defaultUrlGate;
  if (!validate(trimmed)) return text; // refuse to write an invalid URL

  // Dedup on the URL token (ignore the comp column).
  if (parsePipeline(text).includes(trimmed)) return text;

  const comp = sanitizePipelineComp(opts.comp);
  const region = text ? pendingRegion(text) : null;

  // Parent CLI format — append a `- [ ]` row at the end of the Pending
  // section, leaving the Processed section (and every other line) untouched.
  if (region?.cli) {
    const row = `- [ ] ${trimmed}${comp ? ` | ${comp}` : ''}\n`;
    const head = text.slice(0, region.end).replace(/\n*$/, '\n');
    return head + row + '\n' + text.slice(region.end).replace(/^\n+/, '');
  }

  // Legacy fence format — rewrite the fence, preserving existing full lines
  // (including any trailing `| comp` already written).
  const existingLines = (region ? region.block : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      const u = l.split(/\s+\|\s+/)[0].trim();
      return u.startsWith('http') || u.startsWith('local:');
    });
  const newLine = comp ? `${trimmed} | ${comp}` : trimmed;
  const fenceContent = [...existingLines, newLine].join('\n');
  if (text && text.includes('```')) {
    return text.replace(/```[\s\S]*?```/, '```\n' + fenceContent + '\n```');
  }
  return (
    (text || '# Pipeline — Pending URLs\n\nDrop job URLs (one per line) here.\n\n') +
    '```\n' +
    fenceContent +
    '\n```\n'
  );
}

/**
 * Remove a URL from pipeline.md.
 */
export function removePipelineUrl(text, url) {
  if (!text) return text;
  const region = pendingRegion(text);

  // Parent CLI format — drop only the matching `- [ ]` row, keep the rest of
  // the line (company/role/notes columns) out of harm's way.
  if (region.cli) {
    const kept = region.block
      .split('\n')
      .filter((l) => pipelineUrlOf(l) !== url)
      .join('\n');
    return text.slice(0, region.start) + kept + text.slice(region.end);
  }

  const fenceContent = parsePipeline(text).filter((u) => u !== url).join('\n');
  if (text.includes('```')) {
    return text.replace(/```[\s\S]*?```/, '```\n' + fenceContent + '\n```');
  }
  return text;
}

/** Checkbox states a pipeline row may carry: pending / done / skipped. */
export const PIPELINE_STATES = [' ', 'x', '!'];

const CHECKBOX_RE = /^(\s*)-\s+\[([ x!])\]\s*/;

/**
 * Mark a pending pipeline row as done (`- [x]`) or skipped (`- [!]`), with an
 * optional reason appended as a trailing `| reason` column. Works for both
 * formats: a CLI `- [ ] url | Company | …` row keeps its columns, a legacy
 * fence line gains the checkbox prefix. Returns `text` unchanged when the URL
 * isn't pending.
 *
 * ponytail: marked rows stay where they are — we don't move them into the
 * `## Processed` section the parent CLI uses. They drop out of the pending
 * list, which is what the queue cares about; move them if the CLI ever needs it.
 */
export function setPipelineState(text, url, state, reason = '') {
  if (!text || !PIPELINE_STATES.includes(state)) return text;
  const region = pendingRegion(text);
  let found = false;
  const lines = region.block.split('\n').map((line) => {
    if (found || pipelineUrlOf(line) !== url) return line;
    found = true;
    const m = line.match(CHECKBOX_RE);
    const indent = m ? m[1] : (line.match(/^\s*/) || [''])[0];
    const body = (m ? line.slice(m[0].length) : line).trim();
    const note = sanitizePipelineComp(reason);
    return `${indent}- [${state}] ${body}${note ? ` | ${note}` : ''}`;
  });
  return found ? text.slice(0, region.start) + lines.join('\n') + text.slice(region.end) : text;
}

/**
 * Parse a report file's header (the first heading + bold metadata).
 * Returns { title, date, archetype, score, scoreNum, url, legitimacy, pdf }.
 */
export function parseReportHeader(text) {
  const out = {
    title: '',
    date: '',
    archetype: '',
    score: '',
    scoreNum: null,
    url: '',
    legitimacy: '',
    pdf: '',
  };
  if (!text) return out;

  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (titleMatch) out.title = titleMatch[1].trim();

  const fields = {
    date: /\*\*Date:\*\*\s*(.+)/,
    archetype: /\*\*Archetype:\*\*\s*(.+)/,
    score: /\*\*Score:\*\*\s*(.+)/,
    url: /\*\*URL:\*\*\s*(.+)/,
    legitimacy: /\*\*Legitimacy:\*\*\s*(.+)/,
    pdf: /\*\*PDF:\*\*\s*(.+)/,
  };
  for (const [k, re] of Object.entries(fields)) {
    const m = text.match(re);
    if (m) out[k] = m[1].trim();
  }

  if (out.score) {
    const m = out.score.match(/([\d.]+)/);
    out.scoreNum = m ? parseFloat(m[1]) : null;
  }
  return out;
}

/**
 * Slug a string for filename use.
 */
export function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Today as YYYY-MM-DD.
 */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
