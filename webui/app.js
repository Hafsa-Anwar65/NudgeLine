// Nudgeline app: talks to app.py on this computer. Nothing leaves your machine except the AI calls.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { file: null, tone: 'friendly', length: 'short', tones: [], rows: [], meta: {}, run: '', filter: 'all', q: '', sel: null,
    view: 'setup', running: false, hasKey: false, poll: null, runs: [], user: null, plans: {}, demo: false, wantPlan: '', authTab: 'signup' };

  const TONE_DESC = { friendly: 'Warm and approachable. A good default.', professional: 'Polished and respectful, still human.', casual: 'Relaxed and conversational, like a quick message.' };
  const STATUS = {
    draft: { t: 'Ready', c: 'ok' }, needs_edit: { t: 'Check this', c: 'warn' }, approved: { t: 'Approved', c: 'acc' },
    rejected: { t: 'Rejected', c: '' }, skipped: { t: 'Not a fit', c: '' }, error: { t: 'Failed', c: 'bad' },
  };
  const st = (s) => STATUS[s] || { t: s, c: '' };

  // ---------- api ----------
  async function api(path, opts = {}) {
    if (state.demo && /^\/api\/(update|bulk|results|export)/.test(path)) return demoApi(path, opts);
    const res = await fetch(path, { ...opts, headers: { 'X-Nudgeline': '1', ...(opts.headers || {}) } });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : res;
    if (res.status === 401 && state.user) { state.user = null; renderAccount(); showAuth(); }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
    return data;
  }
  // Demo mode keeps everything in memory: edits and approvals work, nothing is saved.
  function demoApi(path, opts) {
    if (path.startsWith('/api/results')) return { run: 'demo', rows: state.rows, meta: state.meta };
    if (path.startsWith('/api/export')) throw new Error('Create a free account to export your approved drafts.');
    if (path.startsWith('/api/regenerate')) throw new Error('Create a free account to rewrite comments with AI.');
    const d = JSON.parse(opts.body || '{}');
    if (path.startsWith('/api/bulk')) { let n = 0; state.rows.forEach((r) => { if (r.status === 'draft') { r.status = 'approved'; n++; } }); return { approved: n }; }
    const row = state.rows.find((r) => r.id === d.id); if (!row) throw new Error('Lead not found');
    ['comment', 'comment_long', 'subject', 'body'].forEach((k) => { if (typeof d[k] === 'string') row[k] = d[k]; });
    if (d.decision === 'approve') row.status = 'approved'; else if (d.decision === 'reject') row.status = 'rejected';
    else if (d.decision === 'reset') row.status = row.qa_flags ? 'needs_edit' : 'draft';
    return row;
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
    ['setup', 'results', 'auth', 'plans', 'admin'].forEach((n) => { $('view-' + n).hidden = v !== n; });
    $('export-bar').hidden = v !== 'results';
    $('acct-menu').hidden = true;
    $('stepper').style.visibility = v === 'setup' || v === 'results' ? 'visible' : 'hidden';
    window.scrollTo({ top: 0 });
    paintStepper();
  }
  $('new-run').addEventListener('click', () => { if (state.demo) { state.authTab = 'signup'; showAuth('Create a free account to run Nudgeline on your own leads.'); } else showView('setup'); });

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

  // Make a text box as tall as its text, so long comments never need inner scrolling.
  function grow(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 4, 700) + 'px'; }
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('#q-comment, #q-long, #detail textarea')) grow(e.target); });
  state.rw = {};
  const LENGTHS = [['short', 'Short'], ['long', 'Longer'], ['both', 'Both']];
  const LENGTH_DESC = { short: '1 to 3 sentences, quick and easy to post.', long: 'A fuller reply of 4 to 7 sentences with more detail.', both: 'Writes a short and a longer version, so you can pick the one that fits.' };
  function renderLength() {
    const box = $('length'); box.innerHTML = '';
    LENGTHS.forEach(([v, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = label; b.setAttribute('aria-checked', String(v === state.length));
      b.addEventListener('click', () => { state.length = v; renderLength(); });
      box.appendChild(b);
    });
    $('length-desc').textContent = LENGTH_DESC[state.length] || '';
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
    const cap = Math.max(1, Math.min(info.usable, state.user ? state.user.max_leads : info.usable)); $('f-limit').max = cap; if (Number($('f-limit').value) > cap) $('f-limit').value = cap;
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
  $('sample-more').addEventListener('click', async () => { try { showFile(await post('/api/sample', { which: 'more' })); toast('20 sample leads added'); } catch (e) { toast(e.message); } });

  // ---------- quick comment: paste one post, get one comment ----------
  async function quickComment() {
    const post = $('q-post').value.trim();
    if (post.length < 5) { $('q-hint').textContent = 'Paste the post text first.'; return; }
    if (!$('f-service').value.trim() || !$('f-about').value.trim()) {
      $('q-hint').textContent = 'Fill in your service and one line about you first.';
      $('card-custom').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('f-service').focus(); return;
    }
    $('q-go').disabled = true; $('q-again').disabled = true; $('q-go').textContent = 'Writing…'; $('q-hint').textContent = '';
    try {
      const r = await post_('/api/quick', { post, name: $('f-name').value, service: $('f-service').value, about: $('f-about').value, tone: state.tone, length: state.length, dry_run: $('f-dry').checked });
      $('q-out').hidden = false;
      $('q-chips').innerHTML = `${r.priority ? `<span class="chip acc">${esc(r.priority)} priority${r.intent ? ' · ' + r.intent + '/5 interest' : ''}</span>` : ''}${r.language ? `<span class="chip">${esc(r.language)}</span>` : ''}`;
      $('q-warn').hidden = !(r.flags && r.flags.length); $('q-warn').innerHTML = r.flags && r.flags.length ? `<b>Worth a look:</b> ${esc(r.flags.join(', '))}. Edit it below if you like.` : '';
      const ok = r.relevant && r.comment;
      $('q-comment').hidden = !ok; $('q-comment').value = r.comment || ''; grow($('q-comment'));
      const both = ok && !!r.comment_long;
      $('q-lbl-short').hidden = !both; $('q-long-wrap').hidden = !both; $('q-long').value = r.comment_long || ''; grow($('q-long'));
      $('q-copy').hidden = !ok || both; $('q-again').textContent = ok ? 'Another version' : 'Try again';
      $('q-note').hidden = ok; $('q-note').textContent = ok ? '' : 'No comment written: ' + (r.reason || 'this post does not look like a request for your service.');
    } catch (e) { $('q-hint').textContent = e.message; }
    $('q-go').disabled = false; $('q-again').disabled = false; $('q-go').textContent = 'Write comment';
  }
  const post_ = post;
  $('q-go').addEventListener('click', quickComment); $('q-again').addEventListener('click', quickComment);
  $('q-copy').addEventListener('click', () => copy($('q-comment').value, 'Comment'));
  $('q-copy-short').addEventListener('click', () => copy($('q-comment').value, 'Short comment'));
  $('q-copy-long').addEventListener('click', () => copy($('q-long').value, 'Longer comment'));

  function updateRun() {
    const why = !state.file ? 'Add your leads first (step 1).' : !$('f-service').value.trim() || !$('f-about').value.trim() ? 'Fill in your service and one line about you (step 2).'
      : !state.hasKey && !$('f-dry').checked ? (state.user && state.user.admin ? 'No AI key found, so tick "Test run" under Advanced options, or add GROQ_API_KEY to your .env file.' : 'AI is not set up yet. Ask the admin, or tick "Test run" under Advanced options.') : '';
    $('run').disabled = !!why || state.running;
    $('run-hint').textContent = state.running ? '' : why || (state.hasKey || $('f-dry').checked ? `Ready. This will draft ${Math.min(Number($('f-limit').value) || 5, state.file.usable)} lead(s).` : '');
    paintStepper();
  }
  ['f-service', 'f-about', 'f-name', 'f-limit', 'f-dry'].forEach((id) => { $(id).addEventListener('input', updateRun); $(id).addEventListener('change', updateRun); });

  $('run').addEventListener('click', async () => {
    $('run-error').hidden = true;
    try {
      await post('/api/run', { file: state.file.file, name: $('f-name').value, service: $('f-service').value, about: $('f-about').value,
        tone: state.tone, length: state.length, template: $('f-template').value, model: $('f-model').value, limit: Number($('f-limit').value) || 5, dry_run: $('f-dry').checked });
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
    pill.textContent = state.hasKey ? (state.user && state.user.admin ? `AI ready (${s.keys.join(', ')})` : 'AI ready') : (state.user && state.user.admin ? 'No AI key: test mode only' : 'AI not set up: use Test run');
    setUnread(s.admin_unread || 0);
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
    state.run = run; state.rows = d.rows; state.meta = d.meta || {}; state.sel = null; state.rw = {};
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

  function rewriteBar(r) {
    const o = state.rw[r.id] || (state.rw[r.id] = { length: r.comment_long ? 'both' : (state.meta.length || state.length || 'short'), tone: state.meta.tone || state.tone });
    return `<div class="rw" id="rw"><span class="rw-t">Rewrite this comment</span>
      <div class="seg seg-sm" id="rw-len" role="radiogroup" aria-label="Length">${LENGTHS.map(([v, l]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === o.length}">${l}</button>`).join('')}</div>
      <select id="rw-tone" aria-label="Tone">${state.tones.map((t) => `<option value="${esc(t)}"${t === o.tone ? ' selected' : ''}>${esc(t[0].toUpperCase() + t.slice(1))}</option>`).join('')}</select>
      <button class="btn btn-primary btn-sm" id="rw-go" type="button">Rewrite</button></div>`;
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
      ${r.post_text ? rewriteBar(r) : ''}
      ${r.comment ? `<div class="blk"><div class="blk-h">${r.comment_long ? 'Short comment' : 'Comment to post'}<button class="copy" data-copy="comment" type="button">Copy</button></div><textarea data-f="comment" rows="3">${esc(r.comment)}</textarea></div>`
        : `<p class="note">No comment: ${esc((r.comment_note || '').replace(/^skipped:\s*/, '') || 'nothing to reply to')}</p>`}
      ${r.comment && r.comment_long ? `<div class="blk long"><div class="blk-h">Longer comment<button class="copy" data-copy="comment_long" type="button">Copy</button></div><textarea data-f="comment_long" rows="7">${esc(r.comment_long)}</textarea></div>` : ''}
      ${hasEmail ? `<div class="blk"><div class="blk-h">Email<button class="copy" data-copy="email" type="button">Copy</button></div><input data-f="subject" type="text" value="${esc(r.subject)}" aria-label="Email subject"><textarea data-f="body" rows="10" style="margin-top:8px">${esc(r.body)}</textarea></div>`
        : (r.angle ? `<p class="note">No email: ${esc(r.angle)}</p>` : '')}
      <div class="d-actions">
        ${locked ? '' : r.status === 'approved' || r.status === 'rejected' ? '<button class="btn btn-ghost btn-sm" data-act="reset" type="button">Undo</button>'
          : '<button class="btn btn-ok btn-sm" data-act="approve" type="button">Approve</button><button class="btn btn-bad btn-sm" data-act="reject" type="button">Reject</button>'}
        <span class="saved">Saved ✓</span>
        <span class="d-nav"><button class="btn btn-ghost btn-sm" id="prev" type="button" aria-label="Previous lead">↑</button><button class="btn btn-ghost btn-sm" id="next" type="button" aria-label="Next lead">↓</button></span>
      </div>`;

    const val = (f) => { const x = box.querySelector(`[data-f="${f}"]`); return x ? x.value : undefined; };
    box.querySelectorAll('textarea').forEach(grow);
    if ($('rw')) {
      const o = state.rw[r.id];
      $('rw-len').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { o.length = b.dataset.v; $('rw-len').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); }));
      $('rw-tone').addEventListener('change', (e) => { o.tone = e.target.value; });
      $('rw-go').addEventListener('click', async () => {
        const btn = $('rw-go'); btn.disabled = true; btn.textContent = 'Writing…';
        try { Object.assign(r, await post('/api/regenerate', { run: state.run, id: r.id, length: o.length, tone: o.tone })); toast('Comment rewritten'); renderAll(); }
        catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Rewrite'; }
      });
    }
    const flash = () => { const e = box.querySelector('.saved'); e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 1300); };
    $('back').addEventListener('click', () => $('view-results').classList.remove('show-detail'));
    box.querySelectorAll('[data-f]').forEach((x) => x.addEventListener('change', async () => {
      try { Object.assign(r, await post('/api/update', { run: state.run, id: r.id, [x.dataset.f]: x.value })); flash(); renderList(); } catch (e) { toast(e.message); }
    }));
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () =>
      b.dataset.copy === 'comment' ? copy(val('comment'), r.comment_long ? 'Short comment' : 'Comment') : b.dataset.copy === 'comment_long' ? copy(val('comment_long'), 'Longer comment') : copy(`Subject: ${val('subject')}\n\n${val('body')}`, 'Email')));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.act === 'approve' && r.qa_flags && !confirm('This draft has warnings:\n\n' + r.qa_flags + '\n\nApprove it anyway?')) return;
      try {
        Object.assign(r, await post('/api/update', { run: state.run, id: r.id, comment: val('comment'), comment_long: val('comment_long'), subject: val('subject'), body: val('body'), decision: b.dataset.act }));
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
    $('export').disabled = n === 0 && !state.demo;
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

  // ---------- accounts, plans, demo ----------
  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  function renderAccount() {
    const u = state.user;
    $('acct').hidden = !u; $('plan-btn').hidden = !u; $('signin-btn').hidden = !!u || state.view === 'auth';
    $('demo-pill').hidden = !state.demo; $('key-pill').hidden = !u;
    if (u) {
      $('acct-btn').textContent = initials(u.name); $('m-name').textContent = u.name; $('m-email').textContent = u.email;
      $('plan-btn').textContent = u.plan_name + ' plan';
    }
    $('m-admin').hidden = !(u && u.admin);
    $('acct-menu').hidden = true; $('acct-btn').setAttribute('aria-expanded', 'false');
  }
  $('acct-btn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('acct-menu'); m.hidden = !m.hidden; $('acct-btn').setAttribute('aria-expanded', String(!m.hidden)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#acct')) $('acct-menu').hidden = true; });
  $('m-plans').addEventListener('click', showPlans); $('plan-btn').addEventListener('click', showPlans);
  $('m-out').addEventListener('click', async () => {
    try { await post('/api/logout', {}); } catch (e) {}
    state.user = null; state.rows = []; state.run = ''; state.file = null; state.demo = false; location.href = '/app';
  });
  $('signin-btn').addEventListener('click', () => { state.authTab = 'login'; showAuth(); });

  function setAuthTab(tab) {
    state.authTab = tab;
    document.querySelectorAll('.auth-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('fld-name').hidden = tab !== 'signup';
    $('auth-go').textContent = tab === 'signup' ? 'Create free account' : 'Sign in';
    $('a-pass').autocomplete = tab === 'signup' ? 'new-password' : 'current-password';
    $('auth-err').hidden = true;
  }
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.tab)));
  function showAuth(msg) {
    showView('auth'); setAuthTab(state.authTab); renderAccount();
    if (msg) { $('auth-err').textContent = msg; $('auth-err').hidden = false; $('auth-err').style.background = 'var(--field)'; $('auth-err').style.color = 'var(--text)'; }
    else { $('auth-err').style.background = ''; $('auth-err').style.color = ''; }
  }
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('auth-err').style.background = ''; $('auth-err').style.color = '';
    const body = { email: $('a-email').value, password: $('a-pass').value, name: $('a-name').value };
    $('auth-go').disabled = true;
    try {
      const r = await post(state.authTab === 'signup' ? '/api/signup' : '/api/login', body);
      state.user = r.user; state.demo = false; $('a-pass').value = '';
      history.replaceState(null, '', '/app');
      await enterApp();
      if (state.wantPlan && state.wantPlan !== 'free' && state.wantPlan !== state.user.plan) showPlans(); else if (state.wantPlan) toast('Welcome to Nudgeline');
      state.wantPlan = '';
    } catch (err) { $('auth-err').textContent = err.message; $('auth-err').hidden = false; }
    $('auth-go').disabled = false;
  });
  $('start-demo').addEventListener('click', startDemo);
  $('demo-signup').addEventListener('click', () => { state.authTab = 'signup'; showAuth('Create a free account to run Nudgeline on your own leads and export approved drafts.'); });

  async function startDemo() {
    try {
      const d = await api('/api/demo');
      state.demo = true; state.run = 'demo'; state.rows = d.rows; state.meta = d.meta; state.filter = 'all'; state.q = ''; $('search').value = '';
      state.sel = (state.rows.find((r) => r.status === 'needs_edit') || state.rows[0]).id;
      showView('results'); $('demo-banner').hidden = false; $('run-select').innerHTML = '<option>Demo run</option>'; $('run-select').disabled = true;
      $('export').textContent = 'Create account to export'; $('export').disabled = false;
      renderAll(); renderAccount();
      if (!store.get('nl-tip-seen')) $('tip').hidden = false;
    } catch (e) { toast(e.message); }
  }
  // exporting in demo mode sends people to sign up instead
  $('export').addEventListener('click', (e) => {
    if (!state.demo) return;
    e.stopImmediatePropagation(); state.authTab = 'signup'; showAuth('Create a free account to export your approved drafts as a CSV.');
  }, true);

  function showPlans() {
    if (!state.user) { state.authTab = 'signup'; showAuth('Create a free account first, then you can pick a plan.'); return; }
    if (state.view !== 'plans') state.prevView = state.view;
    renderPlans(); showView('plans');
  }
  function renderPlans() {
    const cur = state.user.plan, order = ['free', 'pro', 'team'];
    $('plan-grid').innerHTML = order.filter((k) => state.plans[k]).map((k) => {
      const p = state.plans[k], isCur = k === cur;
      const label = isCur ? 'Your current plan' : (p.price > (state.plans[cur] || { price: 0 }).price ? `Subscribe to ${p.name}` : `Switch to ${p.name}`);
      return `<div class="card plan-card ${isCur ? 'current' : ''} ${state.wantPlan === k && !isCur ? 'want' : ''}">
        ${isCur ? '<span class="chip ok cur">Current</span>' : ''}
        <h3>${esc(p.name)}</h3><div class="price">$${p.price}<small> / month</small></div>
        <ul>${p.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <button type="button" class="btn ${k === 'pro' && !isCur ? 'btn-primary' : 'btn-ghost'}" data-plan="${k}" ${isCur ? 'disabled' : ''}>${label}</button></div>`;
    }).join('');
    $('plan-grid').querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await post('/api/plan', { plan: b.dataset.plan }); state.user = r.user; state.wantPlan = '';
        renderAccount(); renderPlans(); toast(`You are now on the ${r.user.plan_name} plan`); applyLimit();
      } catch (e) { toast(e.message); }
    }));
  }
  $('plans-back').addEventListener('click', () => showView(state.prevView === 'results' && state.rows.length ? 'results' : 'setup'));
  function applyLimit() {
    if (!state.user) return;
    const max = state.user.max_leads; $('f-limit').max = state.file ? Math.min(max, state.file.usable) : max;
    if (Number($('f-limit').value) > max) $('f-limit').value = max;
  }

  async function enterApp() {
    const s = await refreshStatus();
    state.tones = s.tones; const d = s.defaults;
    $('f-name').value = d.name || ''; $('f-service').value = d.service || ''; $('f-about').value = d.about || '';
    if (s.tones.includes(d.tone)) state.tone = d.tone;
    if (['short', 'long', 'both'].includes(d.length)) state.length = d.length;
    renderLength();
    renderTone(); $('f-dry').checked = !s.keys.length;
    $('f-model').closest('label').hidden = !state.user.admin;
    $('demo-banner').hidden = true; $('run-select').disabled = false; $('export').textContent = 'Export approved (CSV)';
    state.demo = false; state.rows = []; state.run = '';
    await loadRuns(null, false); if (state.user.admin) loadModels(); applyLimit(); updateRun(); renderAccount(); showView('setup');
    if (s.job.state === 'running') { state.running = true; $('progress').hidden = false; $('run').textContent = 'Writing your drafts…'; updateRun(); poll(); }
  }

  // ---------- admin dashboard (admin only) ----------
  let admTimer = null, lastUnread = 0;
  function setUnread(n) {
    const admin = state.user && state.user.admin;
    $('av-dot').hidden = !(admin && n > 0); $('m-badge').hidden = !(admin && n > 0); $('m-badge').textContent = n;
    if (admin && n > lastUnread) toast('Admin: new AI model notification');
    lastUnread = n;
  }
  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const fmtTime = (iso) => iso ? iso.replace('T', ' ').slice(5, 16) : '–';
  function meter(label, left, total, note) {
    if (left == null || !total) return '';
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    return `<div class="meter"><span>${esc(label)}: ${fmtNum(left)} of ${fmtNum(total)} left${note ? ' · ' + esc(note) : ''}</span><div class="track"><i class="${pct < 10 ? 'crit' : pct < 25 ? 'low' : ''}" style="width:${pct}%"></i></div></div>`;
  }
  function renderAdmin(d) {
    const ready = d.chain.filter((m) => m.status === 'ready').length;
    const req = d.chain.reduce((a, m) => a + m.requests, 0), tok = d.chain.reduce((a, m) => a + m.tokens, 0);
    $('adm-tiles').innerHTML = [['', d.active || '–', 'Serving now'], ['ok', `${ready} of ${d.chain.length}`, 'Models ready'], ['', fmtNum(req), 'Requests today'], ['', fmtNum(tok), 'Tokens today']]
      .map(([c, v, l]) => `<div class="tile ${c}"><b style="font-size:${String(v).length > 14 ? 15 : 24}px;word-break:break-all">${esc(v)}</b><span>${l}</span></div>`).join('');
    $('adm-chain').innerHTML = d.chain.length ? d.chain.map((m) => {
      const chip = m.active && m.status === 'ready' ? '<span class="chip ok">Serving now</span>' : m.status === 'ready' ? '<span class="chip">Standby</span>'
        : m.status === 'cooling' ? `<span class="chip warn">Cooling down · back in ${Math.max(1, Math.round(m.retry_in / 60))} min</span>` : `<span class="chip bad">Disabled: ${esc(m.reason)}</span>`;
      const l = m.limits || {};
      return `<div class="mcard ${m.active && m.status === 'ready' ? 'serving' : ''} ${m.status === 'disabled' ? 'disabled' : ''}">
        <div class="m-top"><div class="m-name"><span class="m-ord">${m.order}</span><code>${esc(m.id)}</code>${chip}</div>
          <div class="m-acts"><button class="btn btn-ghost btn-sm" data-test="${esc(m.id)}" type="button">Test</button>${m.status !== 'ready' ? `<button class="btn btn-ghost btn-sm" data-reset="${esc(m.id)}" type="button">Reset</button>` : ''}</div></div>
        <div class="m-stats"><div><b>${fmtNum(m.requests)}</b>requests today</div><div><b>${fmtNum(m.tokens)}</b>tokens today</div><div><b>${fmtNum(m.errors)}</b>errors today</div><div><b>${fmtTime(m.last_used)}</b>last used</div></div>
        ${meter('Daily budget', m.budget_left, m.budget, 'your setting')}
        ${meter('Requests (provider)', l.rem_req, l.lim_req, l.at ? 'as of ' + fmtTime(l.at) : '')}
        ${meter('Tokens (provider, current window)', l.rem_tok, l.lim_tok, l.at ? 'as of ' + fmtTime(l.at) : '')}
        ${!m.budget && l.rem_req == null && l.rem_tok == null ? '<div class="meter"><span>No usage limit info yet. It appears after the first successful request, or set a budget with @tokens in LLM_CHAIN.</span></div>' : ''}
        ${m.last_error ? `<div class="m-err">Last problem: ${esc(m.last_error)}</div>` : ''}</div>`;
    }).join('') : '<div class="card"><b>No AI keys found.</b><p class="hint">Add GROQ_API_KEY (and optionally XAI_API_KEY or ANTHROPIC_API_KEY) to .env and restart the app.</p></div>';
    $('adm-events').innerHTML = d.events.length ? d.events.map((e) => `<div class="ev ${e.read ? '' : 'unread'}"><span class="lvl ${esc(e.level)}"></span><div class="ev-msg">${esc(e.msg)}</div><time>${esc(fmtTime(e.ts))}</time></div>`).join('')
      : '<p class="hint">Nothing yet. You will see a note here whenever a model runs low, hits a limit, or the app switches to another one.</p>';
    $('adm-chain').querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Testing…';
      try { const r = await post('/api/admin/test', { id: b.dataset.test }); renderAdmin(r.dashboard); toast(r.ok ? 'Model works' : 'Test failed: ' + r.message); } catch (e) { toast(e.message); }
    }));
    $('adm-chain').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => { try { renderAdmin(await post('/api/admin/reset', { id: b.dataset.reset })); toast('Reset'); } catch (e) { toast(e.message); } }));
    setUnread(d.unread);
  }
  async function loadAdmin() { try { renderAdmin(await api('/api/admin/dashboard')); } catch (e) { toast(e.message); } }
  function showAdmin() {
    if (!(state.user && state.user.admin)) return;
    if (state.view !== 'admin') state.prevView = state.view;
    showView('admin'); loadAdmin(); clearInterval(admTimer);
    admTimer = setInterval(() => { if (state.view === 'admin') loadAdmin(); else clearInterval(admTimer); }, 8000);
  }
  $('m-admin').addEventListener('click', showAdmin);
  $('adm-refresh').addEventListener('click', loadAdmin);
  $('adm-back').addEventListener('click', () => showView(state.prevView === 'results' && state.rows.length ? 'results' : 'setup'));
  $('adm-read').addEventListener('click', async () => { try { renderAdmin(await post('/api/admin/read', {})); } catch (e) { toast(e.message); } });
  setInterval(() => { if (state.user && state.user.admin && state.view !== 'admin') refreshStatus().catch(() => {}); }, 30000);

  // ---------- start ----------
  (async () => {
    const q = new URLSearchParams(location.search);
    state.wantPlan = ['free', 'pro', 'team'].includes(q.get('plan')) ? q.get('plan') : '';
    try {
      const me = await api('/api/me');
      state.user = me.user; state.plans = me.plans; state.hasKey = me.keys.length > 0;
      if (state.user) { await enterApp(); if (state.wantPlan && state.wantPlan !== 'free') { showPlans(); } state.wantPlan = state.user ? '' : state.wantPlan; return; }
      renderAccount();
      if (q.get('demo') === '1') { await startDemo(); return; }
      state.authTab = state.wantPlan ? 'signup' : 'signup';
      showAuth(state.wantPlan && state.wantPlan !== 'free' ? `Create a free account, then subscribe to the ${me.plans[state.wantPlan].name} plan.` : '');
    } catch (e) { $('key-pill').hidden = false; $('key-pill').textContent = 'App not reachable'; }
  })();
})();
