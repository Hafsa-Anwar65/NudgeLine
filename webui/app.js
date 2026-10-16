// Nudgeline app: talks to app.py on this computer. Nothing leaves your machine except the AI calls.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { file: null, tone: 'friendly', tones: [], rows: [], meta: {}, run: '', filter: 'all', q: '', sel: null,
    view: 'setup', running: false, hasKey: false, poll: null, runs: [] };

  const TONE_DESC = { friendly: 'Warm and approachable. A good default.', professional: 'Polished and respectful, still human.', casual: 'Relaxed and conversational, like a quick message.' };
  const STATUS = {
    draft: { t: 'Ready', c: 'ok' }, needs_edit: { t: 'Check this', c: 'warn' }, approved: { t: 'Approved', c: 'acc' },
    rejected: { t: 'Rejected', c: '' }, skipped: { t: 'Not a fit', c: '' }, error: { t: 'Failed', c: 'bad' },
  };
  const st = (s) => STATUS[s] || { t: s, c: '' };

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'X-Nudgeline': '1', ...(opts.headers || {}) } });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : res;
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); store.set('nl-theme', next);
  });

  // ---------- views + stepper ----------
  const count = (s) => state.rows.filter((r) => r.status === s).length;
  function currentStep() {
    if (state.view === 'results') return count('approved') > 0 ? 5 : 4;
    if (state.running) return 3;
    if (!state.file) return 1;
    return ready() ? 3 : 2;
  }
  function paintStepper() {
    const cur = currentStep();
    $('stepper').querySelectorAll('li').forEach((li) => {
      const n = Number(li.dataset.s);
      li.className = n < cur ? 'done' : n === cur ? 'on' : '';
    });
  }
  function showView(v) {
    state.view = v;
    $('view-setup').hidden = v !== 'setup'; $('view-results').hidden = v !== 'results';
    $('export-bar').hidden = v !== 'results';
    window.scrollTo({ top: 0 });
    paintStepper();
  }
  $('new-run').addEventListener('click', () => showView('setup'));

  // ---------- setup ----------
  const ready = () => !!(state.file && state.file.usable > 0 && $('f-service').value.trim() && $('f-about').value.trim());

  function renderTone() {
    const box = $('tone'); box.innerHTML = '';
    state.tones.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = t; b.setAttribute('aria-checked', String(t === state.tone));
      b.addEventListener('click', () => { state.tone = t; renderTone(); });
      box.appendChild(b);
    });
    $('tone-desc').textContent = TONE_DESC[state.tone] || '';
  }

  function showFile(info) {
    state.file = info;
    const el = $('file-info'); el.hidden = false;
    const map = Object.entries(info.mapping || {});
    const missing = ['Post', 'Business', 'Owner', 'Email'].filter((k) => !(info.mapping || {})[k]);
    el.innerHTML = `<div class="fi-top"><div><b>${esc(info.file.replace(/^\d+_/, ''))}</b><div class="d-sub">${info.usable} of ${info.rows} rows can be used</div></div>
      <span class="chip ${info.usable ? 'ok' : 'warn'}">${info.usable ? '✓ Looks good' : 'No usable rows'}</span></div>
      <div class="map">${map.map(([k, v]) => `<span class="chip">${esc(k)} ← ${esc(v)}</span>`).join('')}${missing.map((k) => `<span class="chip warn">${esc(k)}: not found</span>`).join('')}</div>
      ${info.preview.length ? `<table class="mini"><thead><tr><th>Business</th><th>Owner</th><th>Email</th><th>Post</th></tr></thead><tbody>${info.preview.map((p) => `<tr><td>${esc(p.company)}</td><td>${esc(p.owner)}</td><td>${esc(p.email)}</td><td>${esc(p.post)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    $('f-limit').max = Math.max(1, info.usable); if (Number($('f-limit').value) > info.usable) $('f-limit').value = info.usable;
    $('run-error').hidden = true; updateRun();
  }

  async function upload(file) {
    try { showFile(await api('/api/upload', { method: 'POST', headers: { 'X-Filename': file.name }, body: file })); toast('File added'); }
    catch (e) { $('run-error').textContent = e.message; $('run-error').hidden = false; }
  }
  const drop = $('drop');
  $('file').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
  $('sample').addEventListener('click', async () => { try { showFile(await post('/api/sample', {})); } catch (e) { toast(e.message); } });

  function updateRun() {
    const why = !state.file ? 'Add your leads first (step 1).' : !$('f-service').value.trim() || !$('f-about').value.trim() ? 'Fill in your service and one line about you (step 2).'
      : !state.hasKey && !$('f-dry').checked ? 'No AI key found, so tick "Test run" under Advanced options, or add GROQ_API_KEY to your .env file.' : '';
    $('run').disabled = !!why || state.running;
    $('run-hint').textContent = state.running ? '' : why || (state.hasKey || $('f-dry').checked ? `Ready. This will draft ${Math.min(Number($('f-limit').value) || 5, state.file.usable)} lead(s).` : '');
    paintStepper();
  }
  ['f-service', 'f-about', 'f-name', 'f-limit', 'f-dry'].forEach((id) => { $(id).addEventListener('input', updateRun); $(id).addEventListener('change', updateRun); });

  $('run').addEventListener('click', async () => {
    $('run-error').hidden = true;
    try {
      await post('/api/run', { file: state.file.file, name: $('f-name').value, service: $('f-service').value, about: $('f-about').value,
        tone: state.tone, template: $('f-template').value, model: $('f-model').value, limit: Number($('f-limit').value) || 5, dry_run: $('f-dry').checked });
      state.running = true; $('run').textContent = 'Writing your drafts…'; $('progress').hidden = false; $('bar-fill').style.width = '4%';
      $('progress-text').textContent = 'Starting…'; updateRun(); poll();
    } catch (e) { $('run-error').textContent = e.message; $('run-error').hidden = false; }
  });

  async function poll() {
    clearTimeout(state.poll);
    try {
      const s = await api('/api/status'); const j = s.job;
      $('log').textContent = j.log.join('\n');
      $('bar-fill').style.width = (j.total ? Math.max(6, (j.done / j.total) * 100) : 6) + '%';
      const last = [...j.log].reverse().find((l) => /^\[\d+\/\d+\]/.test(l));
      $('progress-text').textContent = last ? `Done ${j.done} of ${j.total}: ${last.replace(/^\[\d+\/\d+\]\s*\w+:\s*/, '')}` : j.total ? `Working on ${j.total} lead(s)…` : 'Starting…';
      if (j.state === 'running') { state.poll = setTimeout(poll, 800); return; }
      state.running = false; $('run').textContent = 'Generate drafts';
      if (j.state === 'error') { $('run-error').textContent = j.error; $('run-error').hidden = false; updateRun(); return; }
      $('bar-fill').style.width = '100%'; $('progress').hidden = true; updateRun();
      state.filter = 'all'; state.q = ''; $('search').value = '';
      await loadRuns(j.run, true);
    } catch (e) { state.poll = setTimeout(poll, 2000); }
  }

  // ---------- runs ----------
  async function refreshStatus() {
    const s = await api('/api/status');
    state.hasKey = s.keys.length > 0; state.runs = s.runs;
    const pill = $('key-pill'); pill.className = 'pill ' + (state.hasKey ? 'ok' : 'warn');
    pill.textContent = state.hasKey ? `AI ready (${s.keys[0]})` : 'No AI key: test mode only';
    return s;
  }
  async function loadRuns(select, openResults) {
    await refreshStatus();
    const sel = $('run-select'); sel.innerHTML = '';
    state.runs.forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = fmtRun(r); sel.appendChild(o); });
    if (select) sel.value = select;
    await renderRecent();
    if (select && openResults) { await openRun(sel.value); }
  }
  const fmtRun = (r) => { const m = r.match(/run_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : r; };
  async function renderRecent() {
    const box = $('recent-list'); box.innerHTML = '';
    $('recent').hidden = state.runs.length === 0;
    state.runs.slice(0, 4).forEach((r) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'recent-item';
      b.innerHTML = `<span><b>${esc(fmtRun(r))}</b><br><small>Open these drafts</small></span><span class="link">Open →</span>`;
      b.addEventListener('click', () => { $('run-select').value = r; openRun(r); });
      box.appendChild(b);
    });
  }
  $('run-select').addEventListener('change', (e) => openRun(e.target.value));

  async function openRun(run) {
    const d = await api('/api/results?run=' + encodeURIComponent(run));
    state.run = run; state.rows = d.rows; state.meta = d.meta || {}; state.sel = null;
    $('view-results').classList.remove('show-detail');
    const first = state.rows.find((r) => r.status === 'needs_edit') || state.rows.find((r) => r.status === 'draft') || state.rows[0];
    state.sel = first ? first.id : null;
    showView('results'); renderAll();
    if (!store.get('nl-tip-seen')) $('tip').hidden = false;
  }
  $('tip-close').addEventListener('click', () => { $('tip').hidden = true; store.set('nl-tip-seen', '1'); });

  // ---------- results ----------
  const FILTERS = [['all', 'All'], ['ready', 'Ready'], ['check', 'Check this'], ['approved', 'Approved'], ['other', 'Skipped / failed']];
  const inFilter = (r) => state.filter === 'all' || (state.filter === 'ready' && r.status === 'draft') || (state.filter === 'check' && r.status === 'needs_edit')
    || (state.filter === 'approved' && r.status === 'approved') || (state.filter === 'other' && ['skipped', 'error', 'rejected'].includes(r.status));
  const inSearch = (r) => !state.q || [r.company, r.name, r.email, r.post_text, r.comment, r.subject].join(' ').toLowerCase().includes(state.q);
  const visible = () => state.rows.filter((r) => inFilter(r) && inSearch(r));

  function renderAll() { renderSummary(); renderTabs(); renderList(); renderDetail(); renderExport(); paintStepper(); }

  function renderSummary() {
    const m = state.meta, n = state.rows.length;
    const comments = state.rows.filter((r) => r.comment).length, mails = state.rows.filter((r) => r.body).length;
    $('sum-sub').textContent = [m.source, m.tone && `${m.tone} tone`, m.model, m.seconds != null && `took ${m.seconds}s`].filter(Boolean).join(' · ') || 'Review each draft below.';
    const tiles = [
      ['', 'all', n, 'Leads processed'], ['', 'all', comments, 'Comments written'], ['', 'all', mails, 'Emails written'],
      ['ok', 'ready', count('draft'), 'Ready to approve'], ['warn', 'check', count('needs_edit'), 'Need a quick look'],
      ['bad', 'other', count('skipped') + count('error') + count('rejected'), 'Skipped / failed'],
    ];
    $('tiles').innerHTML = tiles.map(([c, f, v, l]) => `<button type="button" class="tile ${c}" data-f="${f}"><b>${v}</b><span>${l}</span></button>`).join('');
    $('tiles').querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => { state.filter = t.dataset.f; renderTabs(); renderList(); }));
    $('approve-all').disabled = count('draft') === 0;
    $('approve-all').textContent = count('draft') ? `Approve all ready (${count('draft')})` : 'Approve all ready';
  }
  function renderTabs() {
    $('tabs').innerHTML = FILTERS.map(([k, l]) => `<button type="button" role="tab" data-f="${k}" aria-selected="${state.filter === k}">${l}</button>`).join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.f; renderTabs(); renderList(); }));
  }
  function renderList() {
    const rows = visible(), box = $('list');
    if (!rows.length) { box.innerHTML = '<div class="list-empty">Nothing here. Try another filter.</div>'; return; }
    box.innerHTML = rows.map((r) => {
      const s = st(r.status);
      return `<button type="button" class="row" role="option" data-id="${esc(r.id)}" aria-selected="${r.id === state.sel}">
        <span class="dot ${r.priority ? 'p-' + esc(r.priority) : ''}" title="${r.priority ? esc(r.priority) + ' priority' : ''}"></span>
        <span class="r-main"><b>${esc(r.company || r.name || r.email || 'Lead')}</b><small>${esc([r.name, r.email].filter(Boolean).join(' · '))}</small>
        <span class="r-prev">${esc(r.comment || r.subject || r.comment_note || r.angle || '')}</span></span>
        <span class="badge ${s.c}">${s.t}</span></button>`;
    }).join('');
    box.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
  }
  function select(id) {
    state.sel = id; $('view-results').classList.add('show-detail');
    renderList(); renderDetail(); window.scrollTo({ top: 0 });
  }

  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(label + ' copied'), () => toast('Select the text and press Ctrl+C'));
  }

  function renderDetail() {
    const box = $('detail'), r = state.rows.find((x) => x.id === state.sel);
    if (!r) { box.innerHTML = '<div class="empty-d"><h3>Pick a lead</h3><p>Choose one from the list to read and edit its drafts.</p></div>'; return; }
    const s = st(r.status), hasEmail = !!(r.subject || r.body), locked = ['error', 'skipped'].includes(r.status);
    const intent = r.intent_score ? `${r.intent_score}/5 interest` : '';
    box.innerHTML = `
      <button class="btn btn-ghost btn-sm back" type="button" id="back">← All leads</button>
      <div class="d-head"><div><h2>${esc(r.company || r.name || r.email || 'Lead')}</h2><div class="d-sub">${esc([r.name, r.email].filter(Boolean).join(' · '))}</div></div>
        <span class="badge ${s.c}">${s.t}</span></div>
      <div class="chips">${r.priority ? `<span class="chip acc">${esc(r.priority)} priority${intent ? ' · ' + intent : ''}</span>` : ''}${r.language ? `<span class="chip">${esc(r.language)}</span>` : ''}</div>
      ${r.qa_flags ? `<div class="warnbox"><b>Worth a look:</b> ${esc(r.qa_flags)}. Edit the text below, then approve.</div>` : ''}
      ${r.post_text ? `<p class="post"><b>Their post:</b> ${esc(r.post_text)}</p>` : ''}
      ${r.comment ? `<div class="blk"><div class="blk-h">Comment to post<button class="copy" data-copy="comment" type="button">Copy</button></div><textarea data-f="comment" rows="3">${esc(r.comment)}</textarea></div>`
        : `<p class="note">No comment: ${esc((r.comment_note || '').replace(/^skipped:\s*/, '') || 'nothing to reply to')}</p>`}
      ${hasEmail ? `<div class="blk"><div class="blk-h">Email<button class="copy" data-copy="email" type="button">Copy</button></div><input data-f="subject" type="text" value="${esc(r.subject)}" aria-label="Email subject"><textarea data-f="body" rows="10" style="margin-top:8px">${esc(r.body)}</textarea></div>`
        : (r.angle ? `<p class="note">No email: ${esc(r.angle)}</p>` : '')}
      <div class="d-actions">
        ${locked ? '' : r.status === 'approved' || r.status === 'rejected' ? '<button class="btn btn-ghost btn-sm" data-act="reset" type="button">Undo</button>'
          : '<button class="btn btn-ok btn-sm" data-act="approve" type="button">Approve</button><button class="btn btn-bad btn-sm" data-act="reject" type="button">Reject</button>'}
        <span class="saved">Saved ✓</span>
        <span class="d-nav"><button class="btn btn-ghost btn-sm" id="prev" type="button" aria-label="Previous lead">↑</button><button class="btn btn-ghost btn-sm" id="next" type="button" aria-label="Next lead">↓</button></span>
      </div>`;

    const val = (f) => { const x = box.querySelector(`[data-f="${f}"]`); return x ? x.value : undefined; };
    const flash = () => { const e = box.querySelector('.saved'); e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 1300); };
    $('back').addEventListener('click', () => $('view-results').classList.remove('show-detail'));
    box.querySelectorAll('[data-f]').forEach((x) => x.addEventListener('change', async () => {
      try { Object.assign(r, await post('/api/update', { run: state.run, id: r.id, [x.dataset.f]: x.value })); flash(); renderList(); } catch (e) { toast(e.message); }
    }));
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () =>
      b.dataset.copy === 'comment' ? copy(val('comment'), 'Comment') : copy(`Subject: ${val('subject')}\n\n${val('body')}`, 'Email')));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.act === 'approve' && r.qa_flags && !confirm('This draft has warnings:\n\n' + r.qa_flags + '\n\nApprove it anyway?')) return;
      try {
        Object.assign(r, await post('/api/update', { run: state.run, id: r.id, comment: val('comment'), subject: val('subject'), body: val('body'), decision: b.dataset.act }));
        if (b.dataset.act !== 'reset') nextOpen(r.id); renderAll();
      } catch (e) { toast(e.message); }
    }));
    $('prev').addEventListener('click', () => step(-1)); $('next').addEventListener('click', () => step(1));
  }
  function step(d) {
    const rows = visible(), i = rows.findIndex((x) => x.id === state.sel);
    if (i < 0 || !rows.length) return; const n = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    state.sel = n.id; renderList(); renderDetail();
  }
  function nextOpen(afterId) {  // after approving/rejecting, jump to the next lead that still needs a decision
    const rows = state.rows, i = rows.findIndex((x) => x.id === afterId);
    const n = [...rows.slice(i + 1), ...rows.slice(0, i)].find((x) => x.status === 'draft' || x.status === 'needs_edit');
    if (n) state.sel = n.id;
  }

  function renderExport() {
    const n = count('approved'), ready = count('draft') + count('needs_edit');
    $('approved-count').innerHTML = `<b>${n}</b> approved` + (ready ? ` <span class="d-sub">· ${ready} still to review</span>` : '');
    $('export').disabled = n === 0;
  }
  $('approve-all').addEventListener('click', async () => {
    const n = count('draft'); if (!n || !confirm(`Approve the ${n} ready draft(s)?\n\nDrafts marked "Check this" stay untouched so you can review them one by one.`)) return;
    try { await post('/api/bulk', { run: state.run, action: 'approve_ready' }); await openRunKeep(); toast(`${n} approved`); } catch (e) { toast(e.message); }
  });
  async function openRunKeep() {
    const keep = state.sel, d = await api('/api/results?run=' + encodeURIComponent(state.run));
    state.rows = d.rows; state.sel = keep; renderAll();
  }
  $('search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderList(); });
  $('export').addEventListener('click', async () => {
    const n = count('approved');
    if (!n || !confirm(`Export ${n} approved draft(s) as a CSV file?\n\nNudgeline never posts or sends anything: you do that yourself.`)) return;
    try {
      const blob = await (await api('/api/export?run=' + encodeURIComponent(state.run))).blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = state.run + '_approved.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast(`Exported ${n} draft(s)`);
    } catch (e) { toast(e.message); }
  });

  async function loadModels() {
    try { const m = await api('/api/models'); m.models.forEach((id) => { const o = document.createElement('option'); o.value = id; o.textContent = id; $('f-model').appendChild(o); }); } catch (e) {}
  }

  // ---------- start ----------
  (async () => {
    try {
      const s = await refreshStatus();
      state.tones = s.tones; const d = s.defaults;
      $('f-name').value = d.name || ''; $('f-service').value = d.service || ''; $('f-about').value = d.about || '';
      if (s.tones.includes(d.tone)) state.tone = d.tone;
      renderTone(); if (!s.keys.length) $('f-dry').checked = true;
      await loadRuns(null, false); loadModels(); updateRun(); showView('setup');
      if (s.job.state === 'running') { state.running = true; $('progress').hidden = false; $('run').textContent = 'Writing your drafts…'; updateRun(); poll(); }
    } catch (e) { $('key-pill').textContent = 'App not reachable'; }
  })();
})();
