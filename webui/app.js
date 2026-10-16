// Nudgeline app: talks to app.py on this computer. Nothing leaves your machine except the AI calls.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { file: '', tone: 'friendly', rows: [], run: '', filter: 'all', hasKey: false, poll: null };

  // ---- api ----
  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'X-Nudgeline': '1', ...(opts.headers || {}) } });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : res;
    if (!res.ok) throw new Error((data && data.error) || 'Request failed');
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
  }

  // ---- theme ----
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('nl-theme', next); } catch (e) {}
  });

  // ---- setup panel ----
  function renderTone(tones) {
    const box = $('tone'); box.innerHTML = '';
    tones.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = t;
      b.setAttribute('aria-checked', String(t === state.tone));
      b.addEventListener('click', () => { state.tone = t; renderTone(tones); });
      box.appendChild(b);
    });
  }

  function showFile(info) {
    state.file = info.file;
    const el = $('file-info'); el.hidden = false;
    el.innerHTML = `<b>${esc(info.file.replace(/^\d+_/, ''))}</b><small>${info.usable} usable of ${info.rows} rows</small>` +
      (info.preview.length ? `<ul>${info.preview.map((p) => `<li>${esc(p.company || p.owner || p.email)} · ${esc(p.post)}</li>`).join('')}</ul>` : '');
    if (info.usable < 1) { $('run-error').textContent = 'No usable rows found. Check the column names.'; $('run-error').hidden = false; }
    else $('run-error').hidden = true;
    updateRun();
  }

  async function upload(file) {
    try {
      const info = await api('/api/upload', { method: 'POST', headers: { 'X-Filename': file.name }, body: file });
      showFile(info);
    } catch (e) { toast(e.message); $('run-error').textContent = e.message; $('run-error').hidden = false; }
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
    const ready = state.file && $('f-service').value.trim() && $('f-about').value.trim();
    $('run').disabled = !ready || state.running;
  }
  ['f-service', 'f-about', 'f-name'].forEach((id) => $(id).addEventListener('input', updateRun));

  $('run').addEventListener('click', async () => {
    $('run-error').hidden = true;
    try {
      const { run } = await post('/api/run', {
        file: state.file, name: $('f-name').value, service: $('f-service').value, about: $('f-about').value,
        tone: state.tone, template: $('f-template').value, model: $('f-model').value, limit: Number($('f-limit').value) || 5, dry_run: $('f-dry').checked,
      });
      state.run = run; state.running = true; $('run').disabled = true; $('run').textContent = 'Generating…';
      $('progress').hidden = false; $('bar-fill').style.width = '4%';
      poll();
    } catch (e) { $('run-error').textContent = e.message; $('run-error').hidden = false; }
  });

  async function poll() {
    clearTimeout(state.poll);
    try {
      const s = await api('/api/status'); renderStatus(s);
      const j = s.job;
      $('log').textContent = j.log.join('\n');
      $('bar-fill').style.width = (j.total ? Math.max(4, (j.done / j.total) * 100) : 4) + '%';
      $('progress-text').textContent = j.total ? `${j.done} of ${j.total} rows` : 'Starting…';
      if (j.state === 'running') { state.poll = setTimeout(poll, 900); return; }
      state.running = false; $('run').textContent = 'Generate drafts'; updateRun();
      if (j.state === 'error') { $('run-error').textContent = j.error; $('run-error').hidden = false; }
      else { $('bar-fill').style.width = '100%'; await loadRuns(j.run); toast('Drafts ready for review'); }
    } catch (e) { state.poll = setTimeout(poll, 2000); }
  }

  // ---- status / runs ----
  function renderStatus(s) {
    state.hasKey = s.keys.length > 0;
    const pill = $('key-pill');
    pill.className = 'pill ' + (state.hasKey ? 'ok' : 'warn');
    pill.textContent = state.hasKey ? `${s.keys[0]} key found` : 'No API key: test runs only';
    return s;
  }

  async function loadRuns(select) {
    const s = renderStatus(await api('/api/status'));
    const sel = $('run-select'); sel.innerHTML = '';
    s.runs.forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = r.replace('run_', '').replace('_', ' '); sel.appendChild(o); });
    if (select && s.runs.includes(select)) sel.value = select;
    if (s.runs.length) await loadResults(sel.value); else { state.rows = []; render(); }
    return s;
  }
  $('run-select').addEventListener('change', (e) => loadResults(e.target.value));

  async function loadResults(run) {
    state.run = run;
    const d = await api('/api/results?run=' + encodeURIComponent(run));
    state.rows = d.rows; render();
  }

  // ---- results ----
  const FILTERS = [['all', 'All'], ['ready', 'Ready'], ['needs_edit', 'Needs edit'], ['approved', 'Approved'], ['other', 'Skipped / errors']];
  const match = (r) => state.filter === 'all' || (state.filter === 'ready' && r.status === 'draft') || (state.filter === 'other' ? ['skipped', 'error', 'rejected'].includes(r.status) : r.status === state.filter);
  const count = (s) => state.rows.filter((r) => r.status === s).length;

  function render() {
    const rows = state.rows;
    $('empty').hidden = rows.length > 0;
    $('stats').innerHTML = rows.length ? [
      ['ok', count('draft') + ' ready'], ['warn', count('needs_edit') + ' need edit'], ['acc', count('approved') + ' approved'],
      ['', count('skipped') + count('rejected') + ' skipped'], ['bad', count('error') + ' errors'],
    ].map(([c, t]) => `<span class="chip ${c}">${esc(t)}</span>`).join('') : '';
    $('tabs').innerHTML = rows.length ? FILTERS.map(([k, l]) => `<button type="button" role="tab" data-f="${k}" aria-selected="${state.filter === k}">${l}</button>`).join('') : '';
    $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.f; render(); }));
    const box = $('cards'); box.innerHTML = '';
    rows.filter(match).forEach((r) => box.appendChild(card(r)));
    const n = count('approved');
    $('export-bar').hidden = rows.length === 0;
    $('approved-count').innerHTML = `<b>${n}</b> approved` + (n ? '' : ' · approve drafts to export them');
    $('export').disabled = n === 0;
  }

  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(label + ' copied'), () => toast('Select the text and press Ctrl+C'));
  }

  function card(r) {
    const el = document.createElement('article');
    el.className = 'draft s-' + r.status;
    const title = r.company || r.name || r.email || r.id;
    const st = { draft: ['ok', 'ready'], needs_edit: ['warn', 'needs edit'], approved: ['acc', 'approved'], error: ['bad', 'error'], skipped: ['', 'skipped'], rejected: ['', 'rejected'] }[r.status] || ['', r.status];
    const hasEmail = r.subject || r.body;
    const locked = ['error', 'skipped'].includes(r.status);
    el.innerHTML = `
      <div class="d-head"><div><div class="d-title">${esc(title)}</div><div class="d-sub">${esc([r.name, r.email].filter(Boolean).join(' · '))}</div></div>
        <div class="d-chips"><span class="chip ${st[0]}">${st[1]}</span>${r.priority ? `<span class="chip acc">${esc(r.priority)} priority${r.intent_score ? ' · ' + esc(r.intent_score) + '/5' : ''}</span>` : ''}${r.language ? `<span class="chip">${esc(r.language)}</span>` : ''}</div></div>
      ${r.qa_flags ? `<p class="warnline">⚠ ${esc(r.qa_flags)}</p>` : ''}
      ${r.post_text ? `<p class="post">${esc(r.post_text)}</p>` : ''}
      ${r.comment ? `<div class="blk"><div class="blk-h">Comment<button class="copy" data-copy="comment" type="button">Copy</button></div><textarea data-f="comment" rows="3">${esc(r.comment)}</textarea></div>` : `<p class="note">${esc(r.comment_note || '')}</p>`}
      ${hasEmail ? `<div class="blk"><div class="blk-h">Email<button class="copy" data-copy="email" type="button">Copy</button></div><input data-f="subject" type="text" value="${esc(r.subject)}" aria-label="Subject"><textarea data-f="body" rows="9" style="margin-top:8px">${esc(r.body)}</textarea></div>` : (r.angle ? `<p class="note">${esc(r.angle)}</p>` : '')}
      <div class="d-actions">
        ${locked ? '' : r.status === 'approved' || r.status === 'rejected' ? '<button class="btn btn-xs btn-ghost" data-act="reset" type="button">Undo</button>' : '<button class="btn btn-xs btn-ok" data-act="approve" type="button">Approve</button><button class="btn btn-xs btn-bad" data-act="reject" type="button">Reject</button>'}
        <span class="saved">Saved</span>
      </div>`;

    const val = (f) => { const x = el.querySelector(`[data-f="${f}"]`); return x ? x.value : ''; };
    const flash = () => { const s = el.querySelector('.saved'); s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 1200); };
    el.querySelectorAll('[data-f]').forEach((x) => x.addEventListener('change', async () => {
      try {
        const upd = await post('/api/update', { run: state.run, id: r.id, [x.dataset.f]: x.value });
        Object.assign(r, upd); flash();
      } catch (e) { toast(e.message); }
    }));
    el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      copy(b.dataset.copy === 'comment' ? val('comment') : `Subject: ${val('subject')}\n\n${val('body')}`, b.dataset.copy === 'comment' ? 'Comment' : 'Email');
    }));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.act === 'approve' && r.qa_flags && !confirm('This draft has warnings:\n\n' + r.qa_flags + '\n\nApprove it anyway?')) return;
      try {
        const upd = await post('/api/update', { run: state.run, id: r.id, comment: val('comment') || undefined, subject: hasEmail ? val('subject') : undefined, body: hasEmail ? val('body') : undefined, decision: b.dataset.act });
        Object.assign(r, upd); render();
      } catch (e) { toast(e.message); }
    }));
    return el;
  }

  $('export').addEventListener('click', async () => {
    const n = count('approved');
    if (!n || !confirm(`Export ${n} approved draft(s) as CSV?\n\nNudgeline never posts or sends anything: you do that yourself.`)) return;
    try {
      const res = await api('/api/export?run=' + encodeURIComponent(state.run));
      const blob = await res.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = state.run + '_approved.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Exported ' + n + ' rows');
    } catch (e) { toast(e.message); }
  });

  async function loadModels() {
    try {
      const m = await api('/api/models'); const sel = $('f-model');
      m.models.forEach((id) => { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); });
    } catch (e) { /* Auto still works */ }
  }

  // ---- start ----
  (async () => {
    try {
      const s = await api('/api/status');
      renderStatus(s); renderTone(s.tones);
      const d = s.defaults;
      $('f-name').value = d.name || ''; $('f-service').value = d.service || ''; $('f-about').value = d.about || '';
      if (s.tones.includes(d.tone)) { state.tone = d.tone; renderTone(s.tones); }
      if (!s.keys.length) $('f-dry').checked = true;
      updateRun(); loadModels();
      if (s.job.state === 'running') { state.running = true; $('progress').hidden = false; $('run').textContent = 'Generating…'; poll(); }
      await loadRuns(s.runs[0]);
    } catch (e) { $('key-pill').textContent = 'Server not reachable'; }
  })();
})();
