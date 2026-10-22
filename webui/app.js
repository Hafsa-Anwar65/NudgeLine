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
    ['setup', 'results', 'auth', 'plans', 'admin', 'voice'].forEach((n) => { $('view-' + n).hidden = v !== n; });
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
    renderQuickOpts();
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
    renderQuickOpts();
  }
  // Same length and tone choices inside the Quick comment card (kept in sync with step 2).
  function renderQuickOpts() {
    if (!$('q-len')) return;
    const names = { short: 'Short', long: 'Longer', both: 'Short + Longer' };
    $('q-len').innerHTML = LENGTHS.map(([v]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === state.length}">${names[v]}</button>`).join('');
    $('q-tone').innerHTML = (state.tones || []).map((t) => `<button type="button" role="radio" data-v="${esc(t)}" aria-checked="${t === state.tone}">${esc(t[0].toUpperCase() + t.slice(1))}</button>`).join('');
    $('q-len').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.length = b.dataset.v; renderLength(); }));
    $('q-tone').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.tone = b.dataset.v; renderTone(); }));
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
    $('q-approve').textContent = 'Approve and save as example'; $('q-approve').disabled = false;
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
      $('q-copy').hidden = !ok || both; $('q-approve').hidden = !ok; $('q-again').textContent = ok ? 'Another version' : 'Try again';
      $('q-note').hidden = ok; $('q-note').textContent = ok ? '' : 'No comment written: ' + (r.reason || 'this post does not look like a request for your service.');
    } catch (e) { $('q-hint').textContent = e.message; }
    $('q-go').disabled = false; $('q-again').disabled = false; $('q-go').textContent = 'Write comment';
  }
  // ---- approved comments: the AI copies your voice from these ----
  state.ex = [];
  function renderExLine() {
    const n = state.ex.length;
    $('ex-line').innerHTML = n
      ? `<b>${n}</b> saved comment${n === 1 ? '' : 's'} guide${n === 1 ? 's' : ''} the AI so new ones sound like you. <button class="link" type="button" id="ex-open">Manage</button>`
      : `Approve comments you like and the AI will learn your style. You can also <button class="link" type="button" id="ex-open">paste ones you wrote yourself</button>.`;
    $('ex-open').addEventListener('click', openEx);
  }
  const CATS = { website: 'Website development', app: 'App development', logo: 'Logo and branding', marketing: 'Marketing materials', video: 'Video and animation', other: 'Other' };
  state.exCat = 'all';
  function renderExList() {
    const box = $('ex-list'), cnt = {};
    state.ex.forEach((e) => { cnt[e.category] = (cnt[e.category] || 0) + 1; });
    const chip = (k, l, n) => `<button type="button" class="chip${state.exCat === k ? ' on' : ''}" data-cat="${k}">${l} <i>${n}</i></button>`;
    $('ex-filter').innerHTML = state.ex.length ? chip('all', 'All', state.ex.length) + Object.keys(CATS).filter((k) => cnt[k]).map((k) => chip(k, CATS[k], cnt[k])).join('') : '';
    $('ex-filter').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { state.exCat = b.dataset.cat; renderExList(); }));
    if (state.exCat !== 'all' && !cnt[state.exCat]) state.exCat = 'all';
    const list = state.ex.filter((e) => state.exCat === 'all' || e.category === state.exCat);
    box.innerHTML = list.length ? list.map((e) => `<div class="ex-item"><p>${esc(e.comment)}</p>
      ${e.post ? `<small class="ex-post">Reply to: ${esc(e.post.slice(0, 120))}</small>` : ''}
      <div class="ex-meta"><small>${esc({ quick: 'Quick comment', review: 'Approved in review', manual: 'Added by you', import: 'Imported' }[e.source] || 'Saved')}</small>
      <span class="ex-act"><select class="ex-sel" data-id="${esc(e.id)}" aria-label="Category">${Object.keys(CATS).map((k) => `<option value="${k}"${k === e.category ? ' selected' : ''}>${CATS[k]}</option>`).join('')}</select>
      <button class="link" type="button" data-del="${esc(e.id)}">Delete</button></span></div></div>`).join('') : '<p class="note">Nothing saved yet.</p>';
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await post('/api/examples', { action: 'delete', id: b.dataset.del }); state.ex = r.examples; renderExList(); renderExLine(); } catch (e) { toast(e.message); }
    }));
    box.querySelectorAll('.ex-sel').forEach((s) => s.addEventListener('change', async () => {
      try { const r = await post('/api/examples', { action: 'category', id: s.dataset.id, category: s.value }); state.ex = r.examples; renderExList(); toast('Moved to ' + CATS[s.value]); } catch (e) { toast(e.message); }
    }));
  }
  async function loadExamples() { try { state.ex = (await api('/api/examples')).examples || []; } catch (e) { state.ex = []; } renderExLine(); }
  $('ex-cat').innerHTML = '<option value="">Auto detect</option>' + Object.keys(CATS).map((k) => `<option value="${k}">${CATS[k]}</option>`).join('');
  const openEx = () => { renderExList(); $('ex-drawer').hidden = false; document.body.classList.add('no-scroll'); };
  const closeEx = () => { $('ex-drawer').hidden = true; document.body.classList.remove('no-scroll'); };
  $('ex-close').addEventListener('click', closeEx); $('ex-bg').addEventListener('click', closeEx);
  $('ex-add').addEventListener('click', async () => {
    try {
      const r = await post('/api/examples', { comment: $('ex-comment').value, post: $('ex-post').value, category: $('ex-cat').value || undefined, source: 'manual' });
      state.ex = r.examples; $('ex-comment').value = ''; $('ex-post').value = ''; renderExList(); renderExLine(); toast(r.added ? 'Saved' : 'That comment was already saved');
    } catch (e) { toast(e.message); }
  });
  $('q-approve').addEventListener('click', async () => {
    const items = [{ comment: $('q-comment').value, post: $('q-post').value }];
    if (!$('q-long-wrap').hidden) items.push({ comment: $('q-long').value, post: $('q-post').value });
    try {
      const r = await post('/api/examples', { items, source: 'quick' });
      state.ex = r.examples; renderExLine(); $('q-approve').textContent = 'Saved ✓'; $('q-approve').disabled = true;
      toast(r.added ? 'Approved. The AI will learn from it' : 'Already saved');
    } catch (e) { toast(e.message); }
  });

  // ---------- voice and accuracy ----------
  function accMsg(a) {
    if (!a.decided) return 'No decisions yet. Approve or reject comments in a review and this board fills in.';
    if (a.kept_rate >= 75) return 'Great. Most comments are ready as written.';
    if (a.kept_rate >= 45) return 'Getting there. Import more samples to close the gap.';
    return 'Many comments get edited. Import more of your own comments so the AI sounds more like you.';
  }
  function renderAcc(a) {
    const stat = (v, l) => `<div class="stat"><b>${v === null ? '–' : v + '%'}</b><span>${l}</span></div>`;
    $('acc-board').innerHTML = `<div class="stats">${stat(a.kept_rate, 'Used as written')}${stat(a.approve_rate, 'Approved')}${stat(a.closeness, 'Close to AI draft')}</div>
      <p class="hint">${esc(accMsg(a))}</p>
      <div class="bar"><i class="bk" style="width:${a.decided ? 100 * a.kept / a.decided : 0}%"></i><i class="be" style="width:${a.decided ? 100 * a.edited / a.decided : 0}%"></i><i class="br" style="width:${a.decided ? 100 * a.rejected / a.decided : 0}%"></i></div>
      <p class="leg"><span><i class="bk"></i>${a.kept} as written</span><span><i class="be"></i>${a.edited} edited</span><span><i class="br"></i>${a.rejected} rejected</span><span>${a.pending} waiting</span></p>
      ${a.runs.length ? `<table class="acc-t"><thead><tr><th>Run</th><th>As written</th><th>Edited</th><th>Rejected</th><th>Rate</th></tr></thead><tbody>${a.runs.map((r) => `<tr><td>${esc(r.run.replace('run_', ''))}</td><td>${r.kept}</td><td>${r.edited}</td><td>${r.rejected}</td><td><b>${r.rate}%</b></td></tr>`).join('')}</tbody></table>` : ''}
      <p class="hint">${a.flagged} comment${a.flagged === 1 ? '' : 's'} had a warning (for example sounds like AI). Edits made before this update are counted as written.</p>`;
    const s = a.by_source || {};
    $('vs-sources').innerHTML = `<b>${a.samples}</b> of ${a.samples_max} samples saved: ${s.import || 0} imported, ${s.quick || 0} from quick comments, ${s.review || 0} approved in reviews, ${s.manual || 0} added by hand.`;
  }
  async function loadVoice() {
    $('acc-board').innerHTML = '<p class="hint">Loading…</p>';
    try { renderAcc(await api('/api/accuracy')); } catch (e) { $('acc-board').innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  function showVoice() {
    if (!state.user) { state.authTab = 'signup'; showAuth('Create a free account to train the AI on your style.'); return; }
    if (state.view !== 'voice') state.prevView = state.view;
    $('vs-msg').textContent = ''; showView('voice'); loadVoice();
  }
  const impDone = (r) => { state.ex = r.examples; renderExLine(); $('vs-msg').textContent = `${r.added} added${r.skipped ? `, ${r.skipped} skipped (duplicates or too short)` : ''}.`; toast(r.added + ' samples added'); loadVoice(); };
  $('vs-add').addEventListener('click', async () => {
    try { const r = await post('/api/examples/import', { text: $('vs-text').value }); $('vs-text').value = ''; impDone(r); } catch (e) { $('vs-msg').textContent = e.message; }
  });
  $('vs-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const res = await fetch('/api/examples/import', { method: 'POST', headers: { 'X-Nudgeline': '1', 'X-Filename': f.name }, body: f, credentials: 'same-origin' });
      const r = await res.json(); if (!res.ok) throw new Error(r.error || 'Import failed');
      impDone(r);
    } catch (e) { $('vs-msg').textContent = e.message; }
    ev.target.value = '';
  });
  $('vs-manage').addEventListener('click', openEx);
  $('m-voice').addEventListener('click', showVoice); $('voice-btn').addEventListener('click', showVoice);
  $('voice-back').addEventListener('click', () => showView(state.prevView === 'results' && state.rows.length ? 'results' : 'setup'));
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
    const groups = {};
    state.runs.forEach((r) => { const d = dayLabel(r); (groups[d] = groups[d] || []).push(r); });
    Object.keys(groups).forEach((d) => {
      const g = document.createElement('optgroup'); g.label = d;
      groups[d].forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = timeLabel(r) + (r === state.runs[0] ? '  (latest)' : ''); g.appendChild(o); });
      sel.appendChild(g);
    });
    if (select) sel.value = select;
    await renderRecent();
    if (select && openResults) { await openRun(sel.value); }
  }
  const runDate = (r) => { const m = r.match(/run_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };
  function dayLabel(r) {
    const d = runDate(r); if (!d) return 'Other';
    const t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const timeLabel = (r) => { const d = runDate(r); return d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : r; };
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
    const first = state.rows.find((r) => r.status === 'needs_edit') || state.rows.find((r) => r.status === 'draft') || state.rows[0];
    state.sel = first ? first.id : null;
    showView('results'); renderAll();
  }

  // ---------- results ----------
  const FILTERS = [['all', 'All'], ['ready', 'Ready'], ['check', 'Need a look'], ['approved', 'Approved'], ['other', 'Skipped']];
  const inFilter = (r) => state.filter === 'all' || (state.filter === 'ready' && r.status === 'draft') || (state.filter === 'check' && r.status === 'needs_edit')
    || (state.filter === 'approved' && r.status === 'approved') || (state.filter === 'other' && ['skipped', 'error', 'rejected'].includes(r.status));
  const inSearch = (r) => !state.q || [r.company, r.name, r.email, r.post_text, r.comment, r.subject].join(' ').toLowerCase().includes(state.q);
  const visible = () => state.rows.filter((r) => inFilter(r) && inSearch(r));

  function renderAll() { renderSummary(); renderTabs(); renderList(); renderDetail(); renderExport(); paintStepper(); }

  function renderSummary() {
    const m = state.meta, n = state.rows.length;
    $('sum-sub').textContent = [m.source, m.tone && `${m.tone} tone`, m.model].filter(Boolean).join(' · ') || 'Check each lead, then approve it.';
    const ok = count('approved'), look = count('needs_edit'), ready = count('draft');
    const decided = ok + count('rejected') + count('skipped') + count('error');
    $('prog-text').textContent = `${ok} of ${n} approved` + (look ? ` · ${look} need a look` : '') + (ready && !look ? ` · ${ready} to review` : '');
    $('prog-bar').style.width = (n ? Math.round(100 * decided / n) : 0) + '%';
    $('approve-all').disabled = ready === 0;
    $('approve-all').textContent = ready ? `Approve all ready (${ready})` : 'Approve all ready';
  }
  const openDrawer = () => { $('drawer').hidden = false; document.body.classList.add('no-scroll'); renderTabs(); renderList(); };
  const closeDrawer = () => { $('drawer').hidden = true; document.body.classList.remove('no-scroll'); };
  $('open-list').addEventListener('click', openDrawer); $('drawer-close').addEventListener('click', closeDrawer); $('drawer-bg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('drawer').hidden) closeDrawer(); if (!$('ex-drawer').hidden) closeEx(); } });
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
    state.sel = id; closeDrawer();
    renderList(); renderDetail(); window.scrollTo({ top: 0 });
  }

  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(label + ' copied'), () => toast('Select the text and press Ctrl+C'));
  }

  function rewriteBar(r, open) {
    const o = state.rw[r.id] || (state.rw[r.id] = { length: r.comment_long ? 'both' : (state.meta.length || state.length || 'short'), tone: state.meta.tone || state.tone });
    const names = { short: 'Short', long: 'Longer', both: 'Short + Longer' };
    return `<div class="rw" id="rw"${open ? '' : ' hidden'}>
      <div class="rw-g"><span class="rw-l">Length</span><div class="seg seg-sm" id="rw-len" role="radiogroup" aria-label="Length">${LENGTHS.map(([v]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === o.length}">${names[v]}</button>`).join('')}</div></div>
      <div class="rw-g"><span class="rw-l">Tone</span><div class="seg seg-sm" id="rw-tone" role="radiogroup" aria-label="Tone">${state.tones.map((t) => `<button type="button" role="radio" data-v="${esc(t)}" aria-checked="${t === o.tone}">${esc(t[0].toUpperCase() + t.slice(1))}</button>`).join('')}</div></div>
      <button class="btn btn-primary" id="rw-go" type="button">Write it again</button>
      <p class="rw-h">This replaces the comment above with a new one.</p></div>`;
  }

  const words = (t) => { const n = (t || '').trim().split(/\s+/).filter(Boolean).length; return n + (n === 1 ? ' word' : ' words'); };

  function renderDetail() {
    const box = $('detail'), r = state.rows.find((x) => x.id === state.sel);
    if (!r) { box.innerHTML = '<div class="empty-d"><h3>Nothing to show</h3><p>There are no leads in this run.</p></div>'; return; }
    const s = st(r.status), hasEmail = !!(r.subject || r.body), locked = ['error', 'skipped'].includes(r.status);
    const all = visible(), pos = all.findIndex((x) => x.id === r.id) + 1;
    const intent = r.intent_score ? ` · ${r.intent_score}/5 interest` : '';
    const both = !!(r.comment && r.comment_long);
    state.tab = state.tab || {};
    let tab = both && state.tab[r.id] === 'long' ? 'long' : 'short';
    const meta = [r.priority ? r.priority[0].toUpperCase() + r.priority.slice(1) + ' priority' + intent : '', r.language].filter(Boolean).join(' · ');
    box.innerHTML = `
      <div class="navrow"><button class="link" type="button" id="back">☰ All leads</button>
        <span class="pos">Lead ${pos || 1} of ${all.length || state.rows.length}</span>
        <span class="nav2"><button class="btn btn-ghost btn-sm" id="prev" type="button">‹ Previous</button><button class="btn btn-ghost btn-sm" id="next" type="button">Next ›</button></span></div>
      <header class="lead-h"><div><h2>${esc(r.company || r.name || r.email || 'Lead')}</h2><div class="d-sub">${esc([r.name, r.email].filter(Boolean).join(' · '))}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
        <span class="badge ${s.c}">${s.t}</span></header>
      ${r.qa_flags ? `<div class="warnline"><b>Check before approving:</b> ${esc(r.qa_flags)}</div>` : ''}
      <div class="cols${hasEmail ? '' : ' one'}"><div class="col">
      ${r.post_text ? `<section class="part"><h3>Their post</h3><div class="pb"><blockquote class="post">${esc(r.post_text)}</blockquote></div></section>` : ''}
      <section class="part"><h3>Your comment</h3><div class="pb">
        ${r.comment ? `
        ${both ? `<div class="ctabs" role="tablist"><button type="button" role="tab" data-tab="short" aria-selected="${tab === 'short'}">Short</button><button type="button" role="tab" data-tab="long" aria-selected="${tab === 'long'}">Longer</button></div>` : ''}
        <textarea data-f="comment" rows="4" class="big"${tab === 'long' ? ' hidden' : ''}>${esc(r.comment)}</textarea>
        ${both ? `<textarea data-f="comment_long" rows="8" class="big"${tab === 'short' ? ' hidden' : ''}>${esc(r.comment_long)}</textarea>` : ''}
        <div class="sec-row"><button class="btn btn-primary" data-copy="comment" type="button">Copy comment</button>
          ${r.post_text ? '<button class="link" id="rw-toggle" type="button">Change length or tone</button>' : ''}
          <span class="wc" id="wc"></span></div>`
        : `<p class="note">No comment was written: ${esc((r.comment_note || '').replace(/^skipped:\s*/, '') || 'nothing to reply to')}</p>`}
        ${r.post_text ? rewriteBar(r, !r.comment) : ''}
      </div></section></div>
      ${hasEmail ? `<div class="col"><details class="part mail"${window.innerWidth >= 1000 ? ' open' : ''}><summary><h3>Email</h3><span class="sub-prev">${esc(r.subject)}</span></summary><div class="pb">
        <label class="lbl" for="e-sub">Subject</label><input id="e-sub" class="big" data-f="subject" type="text" value="${esc(r.subject)}">
        <label class="lbl" for="e-body">Message</label><textarea id="e-body" class="big" data-f="body" rows="10">${esc(r.body)}</textarea>
        <div class="sec-row"><button class="btn btn-ghost" data-copy="email" type="button">Copy email</button></div></div></details></div>`
        : (r.angle ? `<div class="col"><p class="note">No email: ${esc(r.angle)}</p></div>` : '')}
      </div>
      <div class="d-actions">
        ${locked ? '' : r.status === 'approved' || r.status === 'rejected' ? '<button class="btn btn-ghost" data-act="reset" type="button">Undo</button>'
          : '<button class="btn btn-ok btn-lg-ok" data-act="approve" type="button">✓ Approve</button><button class="btn btn-ghost" data-act="reject" type="button">Reject</button>'}
        <span class="saved">Saved ✓</span>
      </div>`;

    const val = (f) => { const x = box.querySelector(`[data-f="${f}"]`); return x ? x.value : undefined; };
    const active = () => box.querySelector(tab === 'long' ? '[data-f="comment_long"]' : '[data-f="comment"]');
    const count_ = () => { const w = $('wc'), a = active(); if (w && a) w.textContent = words(a.value); };
    box.querySelectorAll('textarea:not([hidden])').forEach(grow); count_();
    box.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => d.open && d.querySelectorAll('textarea').forEach(grow)));
    box.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab; state.tab[r.id] = tab;
      box.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      box.querySelector('[data-f="comment"]').hidden = tab === 'long'; box.querySelector('[data-f="comment_long"]').hidden = tab === 'short';
      grow(active()); count_();
    }));
    box.querySelectorAll('textarea').forEach((x) => x.addEventListener('input', count_));
    if ($('rw')) {
      const o = state.rw[r.id];
      if ($('rw-toggle')) $('rw-toggle').addEventListener('click', () => { $('rw').hidden = !$('rw').hidden; });
      $('rw-len').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { o.length = b.dataset.v; $('rw-len').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); }));
      $('rw-tone').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { o.tone = b.dataset.v; $('rw-tone').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); }));
      $('rw-go').addEventListener('click', async () => {
        const btn = $('rw-go'); btn.disabled = true; btn.textContent = 'Writing…';
        try { Object.assign(r, await post('/api/regenerate', { run: state.run, id: r.id, length: o.length, tone: o.tone })); state.tab[r.id] = 'short'; toast('New comment ready'); renderAll(); }
        catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Write it again'; }
      });
    }
    const flash = () => { const e = box.querySelector('.saved'); e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 1300); };
    $('back').addEventListener('click', openDrawer);
    box.querySelectorAll('[data-f]').forEach((x) => x.addEventListener('change', async () => {
      try { Object.assign(r, await post('/api/update', { run: state.run, id: r.id, [x.dataset.f]: x.value })); flash(); } catch (e) { toast(e.message); }
    }));
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () =>
      b.dataset.copy === 'comment' ? copy(active().value, both ? (tab === 'long' ? 'Longer comment' : 'Short comment') : 'Comment') : copy(`Subject: ${val('subject')}\n\n${val('body')}`, 'Email')));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.act === 'approve' && r.qa_flags && !confirm('This draft has warnings:\n\n' + r.qa_flags + '\n\nApprove it anyway?')) return;
      try {
        Object.assign(r, await post('/api/update', { run: state.run, id: r.id, comment: val('comment'), comment_long: val('comment_long'), subject: val('subject'), body: val('body'), decision: b.dataset.act }));
        if (b.dataset.act === 'approve' && !state.demo) loadExamples();
        if (b.dataset.act !== 'reset') nextOpen(r.id); renderAll(); window.scrollTo({ top: 0 });
      } catch (e) { toast(e.message); }
    }));
    $('prev').addEventListener('click', () => step(-1)); $('next').addEventListener('click', () => step(1));
  }
  function step(d) {
    const rows = visible(), i = rows.findIndex((x) => x.id === state.sel);
    if (i < 0 || !rows.length) return; const n = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    state.sel = n.id; renderList(); renderDetail(); window.scrollTo({ top: 0 });
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
    $('m-admin').hidden = !(u && u.admin); $('voice-btn').hidden = !u;
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
    await loadRuns(null, false); loadExamples(); if (state.user.admin) loadModels(); applyLimit(); updateRun(); renderAccount(); showView('setup');
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
