/* global Router, API, UI, I18n */
Router.register('pipeline', async () => {
  const c = UI.el;
  const t = (k, f) => I18n.t(k, f);

  // F-V54-B — compact, screen-reader-friendly URL for row-action
  // aria-labels: host + the tail of the path (last 2 segments), so two
  // jobs on the same board don't collapse to an identical announced
  // name. Falls back to a trailing slice if the URL won't parse.
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

  // ── state ──
  let allUrls = [];
  let allItems = [];
  let itemByUrl = new Map();   // url → pending-row item (grid cells)
  let rowIndex = new Map();    // url → 1-based position in the rendered order
  let filterQuery = '';
  let activeUrl = null;       // currently selected for preview
  let previewBody = '';
  let previewError = '';   // WS2 #22 — distinct from previewBody
  let previewLoading = false;

  // v1.55.7 — UX-7: a scan can fill the pipeline with 1000s of URLs.
  // Rendering every row (each a flex div + <a> + 2 buttons) on every
  // filter keystroke is slow and floods the a11y tree. Above the
  // threshold we virtualize: render only the scroll viewport ± a
  // small buffer (a vanilla-JS react-window). At/below it we keep the
  // original simple full render so typical pipelines are unchanged.
  const VIRTUALIZE_THRESHOLD = 1000;
  const ROW_H = 40;   // measured uniform row height (px), one grid line
  const BUFFER = 5;   // rows rendered above & below the viewport

  // v1.138.0 — the queue is now a data grid (ag-grid-ish): one shared
  // column template drives the sticky header and every row, so the
  // virtualized absolute rows stay aligned with the header.
  const GRID_COLS = '40px minmax(100px,1.1fr) minmax(150px,1.7fr) minmax(90px,.9fr) '
    + 'minmax(80px,.8fr) minmax(90px,.7fr) minmax(90px,1fr) minmax(120px,1.3fr) 44px';
  const CELL = {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: '13px', minWidth: 0,
  };

  // Row metadata for the grid. Parent CLI rows are
  // `- [ ] <url> | Company | Role [| extra]`; bare rows have no cells,
  // so company/role fall back to the host and a prettified URL slug.
  function prettySlug(url) {
    const s = String(url || '').split('?')[0].replace(/\/+$/, '');
    const segs = s.split('/').filter(Boolean);
    // A bare `…/posting/123` tail says nothing on its own — pull the
    // preceding segment in so the Role cell reads "posting 123".
    const last = (/^\d+$/.test(segs[segs.length - 1] || '') && segs.length > 1
      ? segs.slice(-2).join('-') : segs[segs.length - 1]) || s;
    return last.replace(/\.md$/i, '')
      .replace(/^[a-z]*-?\d{4,}-?/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || last;
  }
  // `local:jds/<board>-<id>-<company>-<role>.md` rows have no host —
  // fall back to the board prefix of the filename so the Company /
  // URL columns still say something sortable.
  function rowSource(url) {
    if (/^local:/i.test(String(url))) {
      const file = String(url).split('/').pop() || '';
      return (file.split('-')[0] || 'local').toLowerCase();
    }
    return shortHost(url);
  }
  // Every column pipeline.md can carry (modes/pipeline.md → "Format of
  // pipeline.md"): `url | Company | Role | Location | Comp | note: … |
  // posted: …`. Columns 3+ are free-form, so they're classified by
  // shape rather than by position, and anything unrecognized falls
  // through to Notes so nothing in the file is silently dropped.
  const COMP_RE = /(\d[\d.,]*\s*[-–—]\s*\d|\d{4,}|\d+\s*k\b|[€$£₽¥]|\b(?:usd|eur|gbp|rub|pln|chf|sek|inr|jpy|brl)\b)/i;
  function classifyCells(cells) {
    const out = { location: '', comp: '', posted: '', notes: [] };
    for (const raw of cells) {
      const m = raw.match(/^(note|notes|posted|added|comp|salary|location|loc)\s*:\s*(.+)$/i);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'posted' || key === 'added') out.posted = out.posted || val;
        else if (key === 'comp' || key === 'salary') out.comp = out.comp || val;
        else if (key === 'location' || key === 'loc') out.location = out.location || val;
        else out.notes.push(val);
        continue;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { out.posted = out.posted || raw; continue; }
      if (COMP_RE.test(raw)) { out.comp = out.comp || raw; continue; }
      if (!out.location) { out.location = raw; continue; }
      out.notes.push(raw);
    }
    return out;
  }
  function rowMeta(url) {
    const item = itemByUrl.get(url);
    const cells = (item ? item.text : '')
      .replace(/^-\s+\[[^\]]*\]\s*/, '')
      .split(/\s+\|\s+/).slice(1)
      .map((s) => s.trim()).filter(Boolean);
    const extra = classifyCells(cells.slice(2));
    return {
      url,
      company: cells[0] || rowSource(url),
      role: cells[1] || prettySlug(url),
      location: extra.location,
      comp: extra.comp,
      posted: extra.posted,
      notes: extra.notes.join(' · '),
      host: rowSource(url),
    };
  }

  // ── sort state ──
  // Default: newest posting first. Rows with no date keep their
  // file order behind the dated ones (Array#sort is stable), so the
  // queue's own priority still shows through where there's no signal.
  // Click a header to re-sort; `sortKey = null` would mean file order.
  let sortKey = 'posted';
  let sortDir = -1;
  function sortRows(urls) {
    if (!sortKey) return urls;
    return urls.slice().sort((a, b) =>
      sortDir * String(rowMeta(a)[sortKey]).localeCompare(String(rowMeta(b)[sortKey]),
        undefined, { numeric: true, sensitivity: 'base' }));
  }
  // Pure window math (no DOM) so it stays unit-checkable.
  function computeWindow(scrollTop, rowH, total, viewportH, buffer) {
    const first = Math.floor(scrollTop / rowH);
    const visible = Math.ceil(viewportH / rowH);
    const start = Math.max(0, first - buffer);
    const end = Math.min(total, first + visible + buffer);
    return { start, end };
  }

  // ── elements ──
  // v1.20.0 — WCAG 1.3.1: every interactive input owns an id +
  // accessible name. `aria-label` covers placeholder-only inputs
  // (no visible label sibling).
  const filterInput = c('input', {
    id: 'pipe-filter',
    'aria-label': t('pipe.filter', 'Filter URLs…'),
    className: 'input',
    placeholder: t('pipe.filter', 'Filter URLs…'),
    style: { maxWidth: '320px' },
  });
  const list = c('div', {
    id: 'pipeline-list', role: 'rowgroup',
    style: { display: 'flex', flexDirection: 'column', gap: '0' },
  });
  // Sticky column header — shares GRID_COLS with every row so the
  // virtualized (absolutely positioned) rows stay aligned.
  const head = c('div', {
    id: 'pipeline-head', role: 'row',
    style: {
      display: 'grid', gridTemplateColumns: GRID_COLS, gap: '10px',
      alignItems: 'center', padding: '0 12px', height: '38px',
      borderBottom: '1px solid var(--slate)', background: 'var(--panel-2, #f5f6f8)',
      fontSize: '12px', fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase',
      color: 'var(--foggy)', position: 'sticky', top: 0, zIndex: 1,
    },
  });
  function sortTh(label, key) {
    if (!key) return c('div', { role: 'columnheader', style: CELL }, label);
    const on = sortKey === key;
    return c('button', {
      role: 'columnheader',
      'aria-sort': on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none',
      style: {
        ...CELL, textAlign: 'inherit', background: 'none', border: 'none', padding: 0,
        font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
        color: on ? 'var(--hof)' : 'inherit', cursor: 'pointer',
      },
      onClick: () => {
        if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
        renderList();
      },
    }, label + (on ? (sortDir === 1 ? ' ▲' : ' ▼') : ''));
  }
  function renderHead() {
    head.innerHTML = '';
    head.appendChild(sortTh('#', null));
    head.appendChild(sortTh(t('scan.col.company', 'Company'), 'company'));
    head.appendChild(sortTh(t('scan.col.role', 'Role'), 'role'));
    head.appendChild(sortTh(t('scan.col.loc', 'Location'), 'location'));
    head.appendChild(sortTh(t('scan.col.salary', 'Salary'), 'comp'));
    head.appendChild(sortTh(t('track.col.date', 'Date'), 'posted'));
    head.appendChild(sortTh(t('followup.notesLbl', 'Notes'), 'notes'));
    head.appendChild(sortTh('URL', 'host'));
    // The actions column is icon-width; its visible label would clip, so
    // the header is named for assistive tech only.
    const actionsTh = c('div', {
      role: 'columnheader', title: t('track.col.actions', 'Actions'),
      style: { ...CELL, textAlign: 'right' },
    }, '⋯');
    actionsTh.setAttribute('aria-label', t('track.col.actions', 'Actions'));
    head.appendChild(actionsTh);
  }
  // v1.48.0 (WS2 #22) — the preview is a polite live region with an
  // accessible name; a fetch failure renders a distinct role=alert
  // block, not disguised as preview body text.
  const previewPane = c('div', {
    id: 'pipe-preview', className: 'card', style: { minHeight: '120px' },
    role: 'region', 'aria-live': 'polite',
    'aria-label': t('pipe.previewRegion', 'Job preview'),
  });
  const newUrl = c('input', {
    id: 'pipe-new-url',
    'aria-label': t('pipe.placeholder'),
    'aria-describedby': 'pipe-new-url-hint',
    className: 'input',
    placeholder: t('pipe.placeholder'),
  });
  const counter = c('strong');

  function shortHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 40); }
  }

  function renderPreview() {
    previewPane.innerHTML = '';
    if (!activeUrl) {
      previewPane.appendChild(c('div', { className: 'empty', style: { border: 'none' } },
        t('pipe.previewIdle', 'Pick a URL to preview, evaluate, or delete.')));
      return;
    }
    const head = c('div', { className: 'flex-between mb-3', style: { flexWrap: 'wrap', gap: '8px' } }, [
      c('div', { style: { minWidth: 0, flex: 1 } }, [
        c('strong', null, shortHost(activeUrl)),
        c('a', {
          href: activeUrl, target: '_blank', rel: 'noopener',
          style: { display: 'block', fontSize: '13px', color: 'var(--foggy)', wordBreak: 'break-all', marginTop: '4px' },
        }, activeUrl),
      ]),
      c('div', { className: 'flex gap-3' }, [
        c('button', {
          className: 'btn btn-primary btn-sm',
          onClick: () => Router.go('/evaluate?url=' + encodeURIComponent(activeUrl)),
        }, '▶ ' + t('pipe.evaluateBtn')),
        c('button', {
          className: 'btn btn-ghost btn-sm',
          onClick: () => window.open(activeUrl, '_blank', 'noopener'),
        }, '↗ ' + t('pipe.openTab', 'Open')),
        c('button', {
          className: 'btn btn-ghost btn-sm',
          onClick: (e) => markUrl(activeUrl, 'x', e.currentTarget),
        }, '✓ ' + t('pipe.markDone', 'Done')),
        c('button', {
          className: 'btn btn-ghost btn-sm',
          onClick: (e) => markUrl(activeUrl, '!', e.currentTarget),
        }, '⏭ ' + t('pipe.markSkip', 'Skip')),
        c('button', {
          className: 'btn btn-ghost btn-sm',
          style: { color: 'var(--rausch)' },
          onClick: async (e) => {
            if (!(await UI.confirm(
              t('pipe.confirmDelTitle', 'Remove from pipeline?'),
              t('pipe.confirmDel'),
              { danger: true, confirmLabel: t('common.delete', 'Delete'), cancelLabel: t('common.cancel', 'Cancel') }))) return;
            await UI.withSpinner(e.currentTarget,
              () => API.del('/api/pipeline?url=' + encodeURIComponent(activeUrl)));
            UI.toast(t('pipe.deleted'));
            activeUrl = null;
            await refresh();
          },
        }, '✕ ' + t('common.delete', 'Delete')),
      ]),
    ]);
    previewPane.appendChild(head);

    if (previewLoading) {
      previewPane.appendChild(c('div', { className: 'loading' }, t('pipe.previewLoading', 'Loading preview…')));
      return;
    }
    if (previewError) {
      previewPane.appendChild(c('div', {
        className: 'empty', role: 'alert',
        style: { border: 'none', padding: '20px', color: 'var(--rausch)' },
      }, '✗ ' + t('pipe.previewError', 'Preview failed') + ': ' + previewError));
      return;
    }
    if (!previewBody) {
      previewPane.appendChild(c('div', { className: 'empty', style: { border: 'none', padding: '20px' } },
        t('pipe.previewUnavailable', 'No preview yet — open in tab to see the page.')));
      return;
    }
    previewPane.appendChild(c('pre', {
      className: 'console',
      style: { maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '13px' },
    }, previewBody));
  }

  async function selectUrl(url) {
    activeUrl = url;
    previewBody = '';
    previewError = '';
    previewLoading = true;
    renderPreview();
    try {
      const r = await API.get('/api/pipeline/preview?url=' + encodeURIComponent(url));
      previewBody = (r.text || '').slice(0, 4000);
    } catch (e) {
      previewError = e.message || 'fetch failed';
    } finally {
      previewLoading = false;
      renderPreview();
    }
  }

  // Mark a queued URL as done (`- [x]`) or skipped (`- [!]`) in
  // data/pipeline.md, with an optional free-text reason. Reuses the
  // focus-trapped UI.confirm modal — the reason input rides in its body.
  async function markUrl(url, state, btn) {
    const label = state === 'x' ? t('pipe.markDone', 'Done') : t('pipe.markSkip', 'Skip');
    const input = c('input', {
      id: 'pipe-mark-reason',
      className: 'input',
      'aria-label': t('pipe.reason', 'Reason (optional)'),
      placeholder: t('pipe.reason', 'Reason (optional)'),
      style: { width: '100%', marginTop: '8px' },
    });
    const body = c('span', { style: { display: 'block' } }, [
      c('span', { style: { display: 'block', wordBreak: 'break-all', color: 'var(--foggy)' } }, shortUrl(url)),
      input,
    ]);
    if (!(await UI.confirm(label, body, {
      danger: false, confirmLabel: label, cancelLabel: t('common.cancel', 'Cancel'),
    }))) return;
    await UI.withSpinner(btn,
      () => API.post('/api/pipeline/mark', { url, state, reason: input.value.trim() }));
    UI.toast(t('pipe.marked', 'Marked') + ': ' + label);
    if (activeUrl === url) { activeUrl = null; previewBody = ''; previewError = ''; }
    await refresh();
  }

  function urlRow(url) {
    const isActive = url === activeUrl;
    const m = rowMeta(url);
    return c('div', {
      className: 'pipeline-row',
      'data-url': url,
      role: 'row',
      style: {
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        alignItems: 'center',
        gap: '10px',
        padding: '0 12px',
        height: ROW_H + 'px',
        borderBottom: '1px solid var(--slate)',
        borderLeft: '2px solid ' + (isActive ? 'var(--rausch)' : 'transparent'),
        background: isActive ? 'var(--beach)' : 'transparent',
        cursor: 'pointer',
      },
      onClick: () => selectUrl(url),
    }, [
      c('div', { role: 'cell', style: { ...CELL, color: 'var(--foggy)', fontVariantNumeric: 'tabular-nums' } },
        String(rowIndex.get(url) || '')),
      c('div', { role: 'cell', title: m.company, style: { ...CELL, fontWeight: 600 } }, m.company),
      c('div', { role: 'cell', title: m.role, style: CELL }, m.role),
      c('div', { role: 'cell', title: m.location, style: CELL }, m.location || '—'),
      c('div', { role: 'cell', title: m.comp, style: CELL }, m.comp || '—'),
      c('div', { role: 'cell', title: m.posted, style: { ...CELL, fontVariantNumeric: 'tabular-nums' } }, m.posted || '—'),
      c('div', { role: 'cell', title: m.notes, style: { ...CELL, color: 'var(--foggy)' } }, m.notes || '—'),
      // Keep an <a> with href so existing tests + accessibility tools
      // can locate the row by URL. stopPropagation prevents the row's
      // selectUrl handler from firing when the link is clicked
      // directly — middle-click / Cmd-click open in a new tab as
      // expected.
      c('div', { role: 'cell', style: CELL }, [
        c('a', {
          href: url,
          target: '_blank',
          rel: 'noopener',
          title: url,
          onClick: (e) => e.stopPropagation(),
          style: { ...CELL, display: 'block', color: 'var(--foggy)', textDecoration: 'none' },
        }, url),
      ]),
      // v1.138.0 — the four icon actions moved into a ⋯ row menu so the
      // grid keeps its columns readable. The menu items are the SAME
      // buttons (F-V54-B aria-labels intact); the ⋯ trigger is named by
      // the row's role so it never collapses to N identical "button"s.
      c('div', { className: 'flex gap-1', role: 'cell', style: { justifyContent: 'flex-end' } }, [
        c('button', {
          className: 'btn btn-ghost btn-sm pipeline-row-menu',
          title: t('track.col.actions', 'Actions'),
          'aria-label': t('track.col.actions', 'Actions') + ': ' + m.role,
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          onClick: (e) => { e.stopPropagation(); toggleMenu(url, e.currentTarget); },
        }, '⋯'),
      ]),
    ]);
  }

  // ── row action menu ──
  // One body-level popover reused by every row: the grid scrolls inside
  // an `overflow:auto` card, so an in-row menu would be clipped.
  const menu = c('div', {
    id: 'pipeline-row-menu', role: 'menu',
    style: {
      position: 'fixed', display: 'none', zIndex: 60, minWidth: '190px',
      padding: '6px', borderRadius: 'var(--radius)', border: '1px solid var(--slate)',
      background: 'var(--panel, #fff)', boxShadow: '0 12px 32px rgba(0,0,0,.22)',
    },
  });
  let menuUrl = null;
  function closeMenu() {
    menu.style.display = 'none';
    menuUrl = null;
    document.querySelectorAll('.pipeline-row-menu[aria-expanded="true"]')
      .forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
  function menuItem(label, icon, onClick, opts = {}) {
    const btn = c('button', {
      className: 'btn btn-ghost btn-sm ' + (opts.className || ''),
      role: 'menuitem',
      title: label,
      style: {
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
        justifyContent: 'flex-start', textAlign: 'left',
        color: opts.danger ? 'var(--rausch)' : 'inherit',
      },
      onClick: (e) => { e.stopPropagation(); closeMenu(); onClick(e); },
    }, [
      c('span', { style: { width: '14px' } }, icon),
      c('span', { style: { flex: '1' } }, label),
      // Fixed mnemonic, shown so it survives i18n (localized labels
      // would give different first letters per locale).
      opts.key ? c('kbd', {
        style: {
          fontSize: '11px', opacity: '.55', border: '1px solid var(--slate)',
          borderRadius: '4px', padding: '0 4px', minWidth: '16px', textAlign: 'center',
        },
      }, opts.key.toUpperCase()) : null,
    ].filter(Boolean));
    if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
    if (opts.key) btn.dataset.key = opts.key;
    return btn;
  }
  function buildMenu(url) {
    menu.innerHTML = '';
    // F-V54-B (v1.54.4): every destructive/stateful action keeps an
    // explicit aria-label disambiguated by a truncated URL, so the
    // a11y tree reads e.g. "Delete: …/jobs/12345".
    menu.appendChild(menuItem(t('pipe.evaluateBtn'), '▶',
      () => Router.go('/evaluate?url=' + encodeURIComponent(url)),
      { key: 'e', ariaLabel: t('pipe.evaluateBtn') + ': ' + shortUrl(url) }));
    menu.appendChild(menuItem(t('pipe.openTab', 'Open'), '↗',
      () => window.open(url, '_blank', 'noopener'), { key: 'o' }));
    menu.appendChild(menuItem(t('pipe.markDone', 'Done'), '✓',
      (e) => markUrl(url, 'x', e.currentTarget),
      { key: 'd', className: 'pipeline-row-done', ariaLabel: t('pipe.markDone', 'Done') + ': ' + shortUrl(url) }));
    menu.appendChild(menuItem(t('pipe.markSkip', 'Skip'), '⏭',
      (e) => markUrl(url, '!', e.currentTarget),
      { key: 's', className: 'pipeline-row-skip', ariaLabel: t('pipe.markSkip', 'Skip') + ': ' + shortUrl(url) }));
    menu.appendChild(menuItem(t('common.delete', 'Delete'), '✕',
      async () => {
        if (!(await UI.confirm(
          t('pipe.confirmDelTitle', 'Remove from pipeline?'),
          t('pipe.confirmDel'),
          { danger: true, confirmLabel: t('common.delete', 'Delete'), cancelLabel: t('common.cancel', 'Cancel') }))) return;
        await API.del('/api/pipeline?url=' + encodeURIComponent(url));
        UI.toast(t('pipe.deleted'));
        if (activeUrl === url) { activeUrl = null; previewBody = ''; previewError = ''; }
        await refresh();
      },
      { key: 'x', className: 'pipeline-row-delete', danger: true, ariaLabel: t('common.delete', 'Delete') + ': ' + shortUrl(url) }));
  }
  function toggleMenu(url, btn) {
    if (menuUrl === url && menu.style.display !== 'none') return closeMenu();
    closeMenu();
    buildMenu(url);
    menuUrl = url;
    menu.style.display = 'block';
    if (!menu.isConnected) document.body.appendChild(menu);
    // Flip above the trigger when the menu would overflow the viewport.
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    const w = menu.offsetWidth;
    menu.style.top = (r.bottom + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    (menu.querySelector('button') || menu).focus();
  }
  document.addEventListener('click', (e) => {
    if (menuUrl && !menu.contains(e.target) && !e.target.closest?.('.pipeline-row-menu')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!menuUrl) return;
    if (e.key === 'Escape') return closeMenu();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Mnemonic shortcuts while the row menu is open: e/o/d/s/x.
    const k = (e.key || '').toLowerCase();
    if (!/^[a-z]$/.test(k)) return; // keeps the attribute selector injection-free
    const hit = menu.querySelector('[data-key="' + k + '"]');
    if (hit) { e.preventDefault(); hit.click(); }
  });
  window.addEventListener('hashchange', closeMenu);

  // Virtualization state (closure-scoped so the single scroll
  // listener always sees the current filtered set).
  let vFiltered = [];
  let vVirtual = false;
  let vInner = null;
  let vRaf = 0;

  function paintWindow() {
    if (!vVirtual || !vInner) return;
    const { start, end } = computeWindow(
      list.scrollTop, ROW_H, vFiltered.length, list.clientHeight || 600, BUFFER);
    vInner.textContent = '';
    for (let i = start; i < end; i++) {
      const row = urlRow(vFiltered[i]);
      row.style.position = 'absolute';
      row.style.left = '0';
      row.style.right = '0';
      row.style.top = (i * ROW_H) + 'px';
      row.style.height = ROW_H + 'px';
      vInner.appendChild(row);
    }
  }
  // One scroll listener for the element's lifetime; rAF-throttled.
  list.addEventListener('scroll', () => {
    if (!vVirtual) return;
    if (vRaf) return;
    vRaf = requestAnimationFrame(() => { vRaf = 0; paintWindow(); });
  });

  function renderList() {
    list.innerHTML = '';
    const q = filterQuery.trim().toLowerCase();
    const filtered = sortRows(q
      ? allItems.filter((item) => (item.text || item.url || '').toLowerCase().includes(q)).map((item) => item.url)
      : allUrls);
    vFiltered = filtered;
    rowIndex = new Map(filtered.map((u, i) => [u, i + 1]));
    renderHead();
    counter.textContent = `${t('pipe.count', 'In queue')}: ${filtered.length}` +
      (q && filtered.length !== allUrls.length ? ` / ${allUrls.length}` : '');
    if (filtered.length === 0) {
      // NOTE: toggle `display` directly — an author `display:grid` rule
      // would beat the UA `[hidden]{display:none}` (v1.58.35 lesson).
      head.style.display = 'none';
      vVirtual = false;
      list.style.removeProperty('max-height');
      list.style.removeProperty('overflow');
      list.style.removeProperty('position');
      list.appendChild(c('div', {
        className: 'empty',
        style: { border: 'none', padding: '20px' },
      }, q ? t('pipe.noResults', 'No matches') : t('pipe.empty')));
      return;
    }
    head.style.display = 'grid';
    if (filtered.length <= VIRTUALIZE_THRESHOLD) {
      // Original simple full render — unchanged for typical pipelines.
      vVirtual = false;
      vInner = null;
      list.style.removeProperty('max-height');
      list.style.removeProperty('overflow');
      list.style.removeProperty('position');
      filtered.forEach((u) => list.appendChild(urlRow(u)));
      return;
    }
    // Virtualized: fixed-height scroll viewport + a sized spacer that
    // preserves the real scrollbar; only the viewport ± BUFFER rows
    // are in the DOM at any time.
    vVirtual = true;
    list.style.position = 'relative';
    list.style.overflow = 'auto';
    list.style.maxHeight = '70vh';
    // `list` keeps its column-flex layout; without flex:0 0 auto the
    // spacer (a flex item, default flex-shrink:1) would be squashed to
    // the 70vh container and the scroll range would collapse — the
    // scrollbar must reflect the FULL virtual height, not the window.
    vInner = c('div', {
      style: {
        position: 'relative',
        flex: '0 0 auto',
        height: (filtered.length * ROW_H) + 'px',
      },
    });
    list.appendChild(vInner);
    list.scrollTop = 0;
    paintWindow();
  }

  async function refresh() {
    const fresh = await API.get('/api/pipeline');
    allUrls = fresh.urls || [];
    allItems = (fresh.items || allUrls.map((url) => ({ url, text: url })))
      .filter((item) => item && item.url);
    itemByUrl = new Map(allItems.map((item) => [item.url, item]));
    renderList();
    renderPreview();
  }

  filterInput.addEventListener('input', (e) => {
    filterQuery = e.target.value;
    renderList();
  });

  // ── initial paint ──
  const initial = await API.get('/api/pipeline');
  allUrls = initial.urls || [];
  allItems = (initial.items || allUrls.map((url) => ({ url, text: url })))
    .filter((item) => item && item.url);
  itemByUrl = new Map(allItems.map((item) => [item.url, item]));
  renderList();
  renderPreview();

  // Pipeline overview strip — inbox count + a breakdown of the tracker by the
  // stages that matter, each linking to #/tracker. Read-only; degrades to just
  // the inbox count if the tracker can't be read.
  let trackerRows = [];
  try { trackerRows = (await API.get('/api/tracker')).rows || []; } catch { trackerRows = []; }
  const statusCount = {};
  for (const r of trackerRows) { const s = (r && r.status) || ''; if (s) statusCount[s] = (statusCount[s] || 0) + 1; }
  function ovChip(n, label, route) {
    const base = { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px', borderRadius: '12px', background: 'var(--panel-2, #eef1f6)', fontSize: '13px', textDecoration: 'none', color: 'inherit' } };
    const kids = [c('strong', { style: { fontVariantNumeric: 'tabular-nums' } }, String(n)), c('span', { style: { color: 'var(--foggy)' } }, label)];
    return route ? c('a', { href: '#' + route, ...base }, kids) : c('span', base, kids);
  }
  const overview = c('div', { className: 'card mb-3', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } }, [
    c('strong', { style: { marginRight: '2px' } }, t('pipe.title', 'Pipeline') + ':'),
    ovChip(allUrls.length, t('pipe.ovInbox', 'in inbox'), '/pipeline'),
    ovChip(trackerRows.length, t('pipe.ovTracked', 'tracked'), '/tracker'),
    ...['Applied', 'Responded', 'Interview', 'Offer'].filter((s) => statusCount[s]).map((s) => ovChip(statusCount[s], s, '/tracker')),
  ]);

  return c('div', null, [
    c('header', { className: 'page-header' }, [
      c('div', null, [
        c('h1', { className: 'page-title' }, t('pipe.title')),
        c('p', { className: 'page-subtitle' }, t('pipe.subtitle')),
      ]),
      c('div', { className: 'flex gap-3' }, [
        c('button', {
          className: 'btn btn-ghost',
          onClick: async () => {
            if (allUrls.length === 0) return UI.toast(t('pipe.empty'), 'error');
            if (!(await UI.confirm(
              t('pipe.evaluateAllTitle', 'Evaluate first queued URL?'),
              t('pipe.evaluateAllConfirm', 'Open the first queued URL on Evaluate?'),
              { danger: false, confirmLabel: t('common.confirm', 'Confirm'), cancelLabel: t('common.cancel', 'Cancel') }))) return;
            Router.go('/evaluate?url=' + encodeURIComponent(allUrls[0]));
          },
        }, '⚡ ' + t('pipe.evaluateAll', 'Evaluate first')),
        c('button', {
          className: 'btn btn-ghost',
          onClick: () => Router.go('/scan'),
        }, t('scan.title')),
      ]),
    ]),

    overview,

    c('div', { className: 'card mb-3' }, [
      c('h3', { style: { marginTop: 0 } }, t('pipe.add')),
      c('div', { className: 'flex gap-3' }, [
        newUrl,
        c('button', {
          className: 'btn btn-primary',
          onClick: async (e) => {
            const u = newUrl.value.trim();
            if (!u) return UI.toast(t('pipe.enterUrl'), 'error');
            try {
              // QA BUG-005 — the server already reports `deduped:true`
              // when the URL was already queued; surface that instead
              // of a misleading "Added to pipeline" green toast.
              const r = await UI.withSpinner(e.currentTarget, () => API.post('/api/pipeline', { url: u }));
              newUrl.value = '';
              if (r && r.deduped) UI.toast(t('pipe.dup', 'Already in the queue — skipped'), 'info');
              else UI.toast(t('pipe.added'), 'success');
              await refresh();
            } catch (err) {
              UI.toast(err.message || 'error', 'error');
            }
          },
        }, '+ ' + t('common.add')),
      ]),
      c('p', { id: 'pipe-new-url-hint', className: 'field-hint mt-3', style: { margin: '12px 0 0' } }, t('pipe.hint')),
    ]),

    // U-9 (v1.58.29) — give the counter ↔ filter row a named class
    // (.pipeline-controls) so the responsive rule can stack them on
    // narrow viewports. At ≤ 720 px the row used to push the filter
    // into a cramped position next to the counter; now they flow
    // vertically with the filter stretching full-width.
    c('div', { className: 'flex gap-3 mb-3 pipeline-controls', style: { alignItems: 'center', flexWrap: 'wrap' } },
      [counter, filterInput]),

    // v1.138.0 — the queue is a full-width data grid (sticky header,
    // sortable columns); the preview pane moved below it so the columns
    // get real horizontal room.
    c('div', {
      className: 'card mb-3', role: 'table', 'aria-label': t('pipe.title', 'Pipeline'),
      style: { padding: 0, overflow: 'auto', maxHeight: '70vh' },
    }, [head, list]),
    previewPane,
  ]);
});
