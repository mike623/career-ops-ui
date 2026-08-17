/* global Router, API, UI, I18n */
Router.register('activity', async () => {
  const c = UI.el;
  const t = (k, f) => I18n.t(k, f);

  // Two histories live on this page: the HTTP audit trail (data/activity.jsonl,
  // written by this server) and the parent project's email-ingest sweeps
  // (data/email-ingest-runs.jsonl, written by ingest-email-labels.mjs).
  // `#/activity?src=email-ingest` deep-links the latter.
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const src = query.get('src') === 'email-ingest' ? 'email-ingest' : 'http';

  const sourceRow = c('div', { className: 'flex gap-3', style: { flexWrap: 'wrap' } }, [
    { key: 'http', hash: '/activity', label: t('activity.src.http', 'HTTP audit') },
    { key: 'email-ingest', hash: '/activity?src=email-ingest', label: t('activity.src.emailIngest', 'Email ingest') },
  ].map((s) => c('button', {
    // `.active` has no styling on ghost buttons, so the selected source would
    // read as selected only to a screen reader (aria-pressed). Use the primary
    // style for the current one so it is visibly selected too.
    className: s.key === src ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm',
    'aria-pressed': String(s.key === src),
    onClick: () => Router.go(s.hash),
  }, s.label)));

  // ---------------------------------------------------------------- HTTP audit

  // Filter chips for the most common action prefixes.
  const FILTERS = [
    { key: '',            label: t('activity.filter.all', 'All actions') },
    { key: 'pipeline.',   label: 'pipeline' },
    { key: 'cv.',         label: 'cv' },
    { key: 'jd.',         label: 'jd' },
    { key: 'evaluate',    label: 'evaluate' },
    { key: 'scan.',       label: 'scan' },
    { key: 'stream.',     label: 'stream' },
    { key: 'script.',     label: 'script' },
  ];
  let activeFilter = '';

  const tableBody = c('tbody');
  const empty = c('div', { className: 'empty' }, t('activity.empty'));
  empty.hidden = true;

  function renderRow(evt) {
    const ts = new Date(evt.ts);
    const time = isNaN(ts) ? evt.ts : ts.toLocaleString();
    const dot = evt.ok === false ? '✗' : evt.ok === true ? '✓' : '·';
    const cls = evt.ok === false ? 'badge-bad' : evt.ok === true ? 'badge-ok' : 'badge-info';
    return c('tr', null, [
      c('td', { style: { whiteSpace: 'nowrap', color: 'var(--foggy)', fontVariantNumeric: 'tabular-nums' } }, time),
      c('td', null, c('code', null, evt.action || '')),
      c('td', { style: { wordBreak: 'break-all', maxWidth: '480px' } }, evt.target || c('span', { style: { color: 'var(--foggy)' } }, '—')),
      c('td', null, [
        c('span', { className: 'badge ' + cls }, dot),
        evt.detail ? c('span', { style: { marginLeft: '8px', color: 'var(--foggy)', fontSize: '13px' } }, evt.detail) : null,
      ]),
    ]);
  }

  // Pagination — we request the most recent 500 events (see load());
  // show 25 per page (paginator clamps on filter change). The activity
  // log grows unbounded, so when we hit the 500 cap the older history
  // is NOT shown — surface that explicitly (WS2 #38; comment was stale
  // at "200" while the code requested 500).
  const CAP = 500;
  let allEvents = [];
  const pgWrap = c('div');
  const truncNote = c('p', {
    className: 'page-subtitle', role: 'note',
    style: { display: 'none', color: 'var(--foggy)', marginTop: '8px' },
  });
  const pager = UI.paginate({ pageSize: 25, onChange: () => render() });

  function render() {
    tableBody.innerHTML = '';
    pgWrap.innerHTML = '';
    if (allEvents.length === 0) {
      empty.hidden = false;
      truncNote.style.display = 'none';
      return;
    }
    empty.hidden = true;
    const page = pager.slice(allEvents);
    for (const evt of page) tableBody.appendChild(renderRow(evt));
    pgWrap.appendChild(pager.controls(page.length, allEvents.length));
    // At the cap the server dropped older events — say so.
    truncNote.textContent = t('activity.truncated', 'Showing the most recent {n} events; older history is not displayed.')
      .replace('{n}', String(CAP));
    truncNote.style.display = allEvents.length >= CAP ? '' : 'none';
  }

  async function load() {
    const params = activeFilter ? `?type=${encodeURIComponent(activeFilter)}&limit=500` : '?limit=500';
    const data = await API.get('/api/activity' + params);
    allEvents = data.events || [];
    pager.reset();
    render();
  }

  const filterRow = c('div', { className: 'flex gap-3', style: { flexWrap: 'wrap' } },
    FILTERS.map((f) =>
      c('button', {
        className: 'btn btn-ghost btn-sm' + (f.key === activeFilter ? ' active' : ''),
        'data-filter': f.key,
        onClick: (e) => {
          activeFilter = f.key;
          filterRow.querySelectorAll('button').forEach((b) =>
            b.classList.toggle('active', b.dataset.filter === f.key));
          load();
        },
      }, f.label)
    )
  );

  // --------------------------------------------------------- Email-ingest runs

  const MUTED = { color: 'var(--foggy)' };

  function fmtDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  function statusBadge(status) {
    const cls = status === 'completed' ? 'badge-ok' : status === 'interrupted' ? 'badge-warn' : 'badge-bad';
    // The status string comes from the log, not from the UI vocabulary —
    // rendered verbatim like `evt.action` above rather than translated.
    return c('span', { className: 'badge ' + cls }, status || 'unknown');
  }

  function kv(label, node) {
    return c('div', { style: { marginBottom: '10px' } }, [
      c('div', { style: { ...MUTED, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
      node,
    ]);
  }

  function runDetail(run) {
    const labels = run.labels.length
      ? c('ul', { style: { margin: '4px 0 0', paddingInlineStart: '18px' } }, run.labels.map((l) =>
          c('li', null, `${l.label} — mails ${l.messages ?? 0}, rows ${l.rows ?? 0}, marked read ${l.markedRead ?? 0}`)))
      : c('span', MUTED, '—');

    const templateEntries = Object.entries(run.templates || {});
    const templates = templateEntries.length
      ? c('div', { className: 'flex gap-3', style: { flexWrap: 'wrap', marginTop: '4px' } },
          templateEntries.map(([id, n]) => c('span', { className: 'badge badge-info' }, `${id} × ${n}`)))
      : c('span', MUTED, '—');

    const unrecognized = run.unrecognized.length
      ? c('ul', { style: { margin: '4px 0 0', paddingInlineStart: '18px' } }, run.unrecognized.map((u) =>
          c('li', null, [c('code', null, `${u.label}#${u.id}`), ' ', u.subject || ''])))
      : c('span', MUTED, '—');

    const argEntries = Object.entries(run.args || {}).filter(([, v]) => v !== '' && v != null);
    const args = argEntries.length
      ? c('div', { className: 'flex gap-3', style: { flexWrap: 'wrap', marginTop: '4px' } },
          argEntries.map(([k, v]) => c('code', null, `${k}=${v}`)))
      : c('span', MUTED, '—');

    return c('div', { className: 'card', style: { margin: '4px 0' } }, [
      kv(t('emailIngest.labels', 'Labels'), labels),
      kv(t('emailIngest.templates', 'Templates'), templates),
      kv(t('emailIngest.unrecognized', 'Unrecognized templates'), unrecognized),
      kv(t('emailIngest.args', 'Flags'), args),
      // Path only, never a download link: that CSV carries sender addresses and
      // raw email bodies, which have no business on an HTTP endpoint.
      kv(t('emailIngest.csv', 'CSV'), run.csv ? c('code', { style: { wordBreak: 'break-all' } }, run.csv) : c('span', MUTED, '—')),
      run.error ? kv(t('common.error', 'Error'), c('code', { style: { wordBreak: 'break-all' } }, run.error)) : null,
    ]);
  }

  function renderRunRows(run, index) {
    const ts = new Date(run.ts);
    const time = isNaN(ts) ? (run.ts || '—') : ts.toLocaleString();
    const mails = run.labels.reduce((sum, l) => sum + (Number(l.messages) || 0), 0);
    const unrecognizedCount = run.unrecognized.length;

    const detailRow = c('tr', null, c('td', { colSpan: 8, style: { padding: '4px 12px 12px' } }, runDetail(run)));
    detailRow.hidden = true;

    const toggle = c('button', {
      className: 'btn btn-ghost btn-sm',
      'aria-expanded': 'false',
      'aria-controls': `email-ingest-detail-${index}`,
      onClick: (e) => {
        const open = detailRow.hidden;
        detailRow.hidden = !open;
        e.currentTarget.setAttribute('aria-expanded', String(open));
      },
    }, t('emailIngest.detail', 'Details'));
    detailRow.id = `email-ingest-detail-${index}`;

    const num = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
    const summaryRow = c('tr', null, [
      c('td', { style: { ...MUTED, ...num } }, time),
      c('td', null, statusBadge(run.status)),
      c('td', { style: num }, fmtDuration(run.durationMs)),
      c('td', { style: num }, String(run.rows)),
      c('td', { style: num }, String(mails)),
      c('td', { style: num }, unrecognizedCount
        ? c('span', { className: 'badge badge-warn' }, String(unrecognizedCount))
        : c('span', MUTED, '0')),
      c('td', { style: num }, run.ingestExit === null ? c('span', MUTED, '—') : String(run.ingestExit)),
      c('td', { style: { textAlign: 'end' } }, toggle),
    ]);

    return [summaryRow, detailRow];
  }

  const runsBody = c('tbody');
  const runsEmpty = c('div', { className: 'empty' },
    t('emailIngest.empty', 'No email-ingest runs recorded yet. Run `node ingest-email-labels.mjs discovery` in the career-ops project.'));
  runsEmpty.hidden = true;

  async function loadRuns() {
    const data = await API.get('/api/email-ingest/runs?limit=100');
    const runs = data.runs || [];
    runsBody.innerHTML = '';
    runsEmpty.hidden = runs.length > 0;
    runs.forEach((run, i) => { for (const row of renderRunRows(run, i)) runsBody.appendChild(row); });
  }

  // ---------------------------------------------------------------------- view

  if (src === 'email-ingest') await loadRuns(); else await load();

  const header = c('header', { className: 'page-header' }, [
    c('div', null, [
      c('h1', { className: 'page-title' }, t('activity.title')),
      c('p', { className: 'page-subtitle' }, src === 'email-ingest'
        ? t('emailIngest.subtitle', 'Every sweep of your job-alert mail labels — newest first.')
        : t('activity.subtitle')),
    ]),
    c('div', { className: 'flex gap-3' }, [
      c('button', {
        className: 'btn btn-ghost',
        onClick: (e) => UI.withSpinner(e.currentTarget, src === 'email-ingest' ? loadRuns : load),
      }, t('activity.refresh')),
    ]),
  ]);

  if (src === 'email-ingest') {
    return c('div', null, [
      header,
      c('div', { className: 'card mb-3' }, [sourceRow]),
      runsEmpty,
      c('div', { className: 'table-wrap' },
        c('table', { className: 'tbl' }, [
          c('thead', null, c('tr', null, [
            t('activity.col.time'),
            t('emailIngest.col.status', 'Status'),
            t('emailIngest.col.duration', 'Duration'),
            t('emailIngest.col.rows', 'Rows'),
            t('emailIngest.col.messages', 'Mails'),
            t('emailIngest.col.unrecognized', 'Unrecognized'),
            t('emailIngest.col.ingest', 'Ingest'),
            '', // per-row Details toggle
          ].map((h) => c('th', null, h)))),
          runsBody,
        ])
      ),
    ]);
  }

  return c('div', null, [
    header,
    c('div', { className: 'card mb-3' }, [sourceRow]),
    c('div', { className: 'card mb-3' }, [filterRow]),
    empty,
    c('div', { className: 'table-wrap' },
      c('table', { className: 'tbl' }, [
        c('thead', null, c('tr', null,
          [t('activity.col.time'), t('activity.col.action'), t('activity.col.target'), t('activity.col.result')]
            .map((h) => c('th', null, h))
        )),
        tableBody,
      ])
    ),
    pgWrap,
    truncNote,
  ]);
});
