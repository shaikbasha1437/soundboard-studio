/* SoundBoard Studio app: UI, look-ahead scheduler, live recording, export, storage. */
(function () {
  'use strict';
  const C = window.SBSCore, PR = window.SBSPresets, SY = window.SBSSynth;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const LS_KEY = 'sbs-project-v1', LS_SAVES = 'sbs-saves-v1';

  // ---------- state ----------
  let P = loadAutosave() || PR.build('hiphop');
  const hist = new C.History(150);
  hist.reset(JSON.stringify(P));
  const ui = { roll: 'bass', vel: 1, len: 1, lock: true, playing: false, recording: false, playStep: -1, playPat: null, songIdx: -1, taps: [], tab: 'roll' };

  // ---------- audio ----------
  let ctx = null, eng = null, clock = null, ticker = null;
  const visQ = [];
  const skipOnce = new Set();
  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { toast('This browser has no Web Audio support.'); return null; }
      ctx = new AC({ latencyHint: 'interactive' });
      eng = SY.createEngine(ctx); eng.applyMixer(P, false);
      // iOS unlock: play one silent buffer inside the first gesture.
      try { const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) { /* ignore */ }
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  const unlock = () => { ensureAudio(); if (ctx && ctx.state === 'running') ['pointerdown', 'touchend', 'keydown'].forEach((e) => document.removeEventListener(e, unlock, true)); };
  ['pointerdown', 'touchend', 'keydown'].forEach((e) => document.addEventListener(e, unlock, true));

  // A worker timer keeps ticking when the tab is in the background (setInterval would be throttled).
  function makeTicker(fn) {
    try {
      const src = 'let i=null;onmessage=e=>{clearInterval(i);i=null;if(e.data>0)i=setInterval(()=>postMessage(0),e.data)}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = fn;
      return { start: () => w.postMessage(25), stop: () => w.postMessage(0) };
    } catch (e) { let i = null; return { start: () => { clearInterval(i); i = setInterval(fn, 25); }, stop: () => { clearInterval(i); i = null; } }; }
  }
  const LOOKAHEAD = 0.12;
  function tick() {
    if (!ui.playing || !ctx) return;
    for (const ev of clock.due(ctx.currentTime, LOOKAHEAD)) {
      const pos = C.songPosition(ev.n, P);
      const pat = P.patterns[pos.pattern];
      const hits = [];
      for (const e of C.stepEvents(pat, pos.step, P)) {
        if (skipOnce.delete(ev.n + ':' + e.track)) continue;
        eng.trigger(e.track, ev.time, e.vel, e.midi, e.len ? e.len * clock.dur * 0.95 : 0);
        if (C.isAudible(P.mixer, e.track)) hits.push(e.track);
      }
      visQ.push({ time: ev.time, pos, hits });
    }
  }
  function play() {
    if (!ensureAudio()) return;
    if (ui.playing) return;
    clock = new C.Clock(P.bpm, P.swing); clock.start(ctx.currentTime + 0.06);
    ui.playing = true; visQ.length = 0; skipOnce.clear();
    if (!ticker) ticker = makeTicker(tick);
    ticker.start(); tick();
    document.body.classList.add('playing'); $('#playBtn').setAttribute('aria-label', 'Stop');
    requestAnimationFrame(draw);
    setTimeout(() => { if (ui.playing && ctx.state !== 'running') toast('Audio is paused by the browser. Tap anywhere, or check your sound output.'); }, 3000);
  }
  function stop() {
    if (!ui.playing) return;
    ui.playing = false; if (ticker) ticker.stop();
    visQ.length = 0; ui.playStep = -1; ui.playPat = null; ui.songIdx = -1;
    document.body.classList.remove('playing'); $('#playBtn').setAttribute('aria-label', 'Play');
    paintPlayhead(); renderChain();
  }
  const toggle = () => (ui.playing ? stop() : play());

  function draw() {
    if (!ui.playing) return;
    const now = ctx.currentTime; let changed = false, last = null;
    while (visQ.length && visQ[0].time <= now) { last = visQ.shift(); for (const h of last.hits) flashPad(h); changed = true; }
    if (changed) {
      const songChanged = last.pos.idx !== ui.songIdx;
      ui.playStep = last.pos.step; ui.playPat = last.pos.pattern; ui.songIdx = last.pos.idx;
      paintPlayhead(); if (songChanged) renderChain();
    }
    if (eng) { const r = Math.min(1, Math.abs(eng.reduction()) / 12); const m = $('#limMeter'); if (m) m.style.width = (r * 100).toFixed(0) + '%'; }
    requestAnimationFrame(draw);
  }

  // ---------- pads ----------
  const padEls = {};
  function buildPads() {
    const box = $('#pads'); box.innerHTML = '';
    for (const t of C.TRACKS) {
      const b = document.createElement('button');
      b.className = 'pad ' + t.kind; b.dataset.track = t.id; b.style.setProperty('--h', t.hue);
      b.innerHTML = `<span class="pname">${t.name}</span><kbd>${t.key.toUpperCase()}</kbd>`;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); hitPad(t.id, e.pressure && e.pointerType === 'pen' ? Math.max(0.3, e.pressure) : 1); });
      box.appendChild(b); padEls[t.id] = b;
    }
  }
  function flashPad(id) { const el = padEls[id]; if (!el) return; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
  function hitPad(id, vel) {
    if (!ensureAudio()) return;
    const t = C.TRACK_BY_ID[id];
    const midi = t.kind === 'synth' ? C.rootNote(id, P.key) : undefined;
    const now = ctx.currentTime;
    eng.trigger(id, now, vel, midi, t.kind === 'synth' ? 0.3 : 0);
    flashPad(id);
    if (t.kind === 'synth' && ui.roll !== id) { ui.roll = id; renderRollTracks(); renderRoll(); }
    if (ui.recording && ui.playing) recordHit(id, vel, midi, now);
  }
  function recordHit(id, vel, midi, time) {
    const n = clock.nearestStep(time);
    const pos = C.songPosition(n, P);
    const pat = P.patterns[pos.pattern];
    const t = C.TRACK_BY_ID[id];
    if (t.kind === 'drum') pat.d[id][pos.step] = Math.max(pat.d[id][pos.step], vel * ui.vel);
    else if (!pat.m[id].some((x) => x.s === pos.step && x.n === midi)) { pat.m[id].push({ s: pos.step, n: midi, v: ui.vel, l: ui.len }); pat.m[id].sort((a, b) => a.s - b.s || a.n - b.n); }
    if (n >= clock.n) skipOnce.add(n + ':' + id); // already heard live; don't double it this pass
    commit(false); if (pos.pattern === P.current) { paintSeq(); if (t.kind === 'synth') renderRoll(); }
  }

  // ---------- sequencer grid ----------
  function buildSeq() {
    const box = $('#seq'); box.innerHTML = '';
    box.style.setProperty('--steps', P.steps);
    const head = document.createElement('div'); head.className = 'srow ruler';
    head.innerHTML = '<div class="shead"></div>' + Array.from({ length: P.steps }, (_, i) => `<div class="num${i % 4 === 0 ? ' beat' : ''}" data-s="${i}">${i % 4 === 0 ? i / 4 + 1 : ''}</div>`).join('');
    box.appendChild(head);
    for (const t of C.TRACKS) {
      const row = document.createElement('div'); row.className = 'srow ' + t.kind; row.dataset.track = t.id; row.style.setProperty('--h', t.hue);
      let html = `<div class="shead"><button class="tname" data-act="sel" title="${t.kind === 'synth' ? 'Edit in piano roll' : 'Preview'}">${t.name}</button><button class="ms m" data-act="mute" title="Mute">M</button><button class="ms s" data-act="solo" title="Solo">S</button></div>`;
      for (let i = 0; i < P.steps; i++) html += `<button class="cell${i % 4 === 0 ? ' beat' : ''}${Math.floor(i / 4) % 2 ? ' alt' : ''}" data-s="${i}" aria-label="${t.name} step ${i + 1}"></button>`;
      row.innerHTML = html; box.appendChild(row);
    }
    paintSeq(); paintPlayhead();
  }
  function paintSeq() {
    const pat = P.patterns[P.current];
    for (const row of $$('#seq .srow[data-track]')) {
      const id = row.dataset.track, t = C.TRACK_BY_ID[id], m = P.mixer[id];
      row.classList.toggle('muted', !C.isAudible(P.mixer, id));
      $('.m', row).classList.toggle('on', m.mute); $('.s', row).classList.toggle('on', m.solo);
      row.classList.toggle('selected', id === ui.roll);
      const cells = $$('.cell', row);
      if (t.kind === 'drum') {
        cells.forEach((c, i) => { const v = pat.d[id][i]; c.classList.toggle('on', v > 0); c.style.setProperty('--v', v); c.title = v ? Math.round(v * 100) + '%' : ''; });
      } else {
        const start = new Map(), cover = new Set();
        for (const n of pat.m[id]) { start.set(n.s, Math.max(start.get(n.s) || 0, n.v)); for (let k = n.s + 1; k < n.s + n.l && k < P.steps; k++) cover.add(k); }
        cells.forEach((c, i) => { const v = start.get(i) || 0; c.classList.toggle('on', v > 0); c.classList.toggle('tail', !v && cover.has(i)); c.style.setProperty('--v', v || 0.5); c.title = v ? pat.m[id].filter((n) => n.s === i).map((n) => C.noteName(n.n)).join(' ') : ''; });
      }
    }
    $$('.pat').forEach((b) => { b.classList.toggle('active', b.dataset.pat === P.current); b.classList.toggle('has', !C.patternIsEmpty(P.patterns[b.dataset.pat])); });
  }
  let lastHead = [];
  function paintPlayhead() {
    lastHead.forEach((c) => c.classList.remove('now')); lastHead = [];
    if (ui.playStep < 0 || ui.playPat !== P.current) { $$('.pat').forEach((b) => b.classList.toggle('playing', ui.playing && b.dataset.pat === ui.playPat)); return; }
    lastHead = $$(`#seq [data-s="${ui.playStep}"], #roll [data-s="${ui.playStep}"]`);
    lastHead.forEach((c) => c.classList.add('now'));
    $$('.pat').forEach((b) => b.classList.toggle('playing', b.dataset.pat === ui.playPat));
  }
  function onSeqClick(e, cycle) {
    const btn = e.target.closest('button'); if (!btn) return;
    const row = btn.closest('.srow'); if (!row || !row.dataset.track) return;
    const id = row.dataset.track, t = C.TRACK_BY_ID[id], pat = P.patterns[P.current];
    if (btn.dataset.act === 'mute') { P.mixer[id].mute = !P.mixer[id].mute; mixChanged(); return; }
    if (btn.dataset.act === 'solo') { P.mixer[id].solo = !P.mixer[id].solo; mixChanged(); return; }
    if (btn.dataset.act === 'sel') { if (t.kind === 'synth') { ui.roll = id; renderRollTracks(); renderRoll(); showTab('roll'); paintSeq(); } hitPad(id, 0.9); return; }
    if (!btn.classList.contains('cell')) return;
    const s = +btn.dataset.s;
    if (t.kind === 'drum') {
      if (cycle) pat.d[id][s] = C.cycleVelocity(pat.d[id][s]); else C.tapDrumStep(pat.d[id], s, ui.vel);
      if (pat.d[id][s] && !ui.playing) { ensureAudio(); if (eng) eng.trigger(id, ctx.currentTime, pat.d[id][s]); }
    } else {
      const here = pat.m[id].filter((n) => n.s === s);
      if (cycle && here.length) { const nv = C.cycleVelocity(here[0].v); here.forEach((n) => (n.v = nv)); }
      else if (here.length) pat.m[id] = pat.m[id].filter((n) => n.s !== s);
      else { const midi = C.rootNote(id, P.key); C.toggleNote(pat.m[id], s, midi, ui.vel, ui.len); if (!ui.playing) { ensureAudio(); if (eng) eng.trigger(id, ctx.currentTime, ui.vel, midi, 0.25); } }
      if (id === ui.roll) renderRoll();
    }
    commit(); paintSeq();
  }

  // ---------- piano roll ----------
  function rollNotes() { const b = C.TRACK_BY_ID[ui.roll].base; return C.scaleNotes(P.key, ui.lock ? P.scale : 'chromatic', b, b + C.ROLL_SPAN).reverse(); }
  function renderRollTracks() {
    $('#rollTracks').innerHTML = C.SYNTH_IDS.map((id) => `<button data-roll="${id}" class="${id === ui.roll ? 'on' : ''}" style="--h:${C.TRACK_BY_ID[id].hue}">${C.TRACK_BY_ID[id].name.replace(' synth', '')}</button>`).join('');
  }
  function renderRoll() {
    const box = $('#roll'); const notes = rollNotes(); const list = P.patterns[P.current].m[ui.roll];
    box.style.setProperty('--steps', P.steps); box.style.setProperty('--h', C.TRACK_BY_ID[ui.roll].hue);
    const at = new Map();
    for (const n of list) for (let k = n.s; k < n.s + n.l && k < P.steps; k++) at.set(k + ':' + n.n, k === n.s ? 'on' : 'tail');
    let html = '';
    for (const m of notes) {
      const isRoot = ((m - P.key) % 12 + 12) % 12 === 0;
      html += `<div class="rrow${isRoot ? ' root' : ''}${C.inScale(m, P.key, P.scale) ? '' : ' off'}" data-n="${m}"><div class="rkey">${C.noteName(m)}</div>`;
      for (let i = 0; i < P.steps; i++) { const st = at.get(i + ':' + m) || ''; html += `<button class="rc${i % 4 === 0 ? ' beat' : ''} ${st}" data-s="${i}" aria-label="${C.noteName(m)} step ${i + 1}"></button>`; }
      html += '</div>';
    }
    const hidden = list.filter((n) => !notes.includes(n.n)).length;
    if (hidden) html += `<p class="muted small">${hidden} note(s) outside this view.</p>`;
    box.innerHTML = html; paintPlayhead();
  }
  function onRollClick(e) {
    const c = e.target.closest('.rc'); if (!c) return;
    const m = +c.parentElement.dataset.n, s = +c.dataset.s;
    const added = C.toggleNote(P.patterns[P.current].m[ui.roll], s, m, ui.vel, ui.len);
    if (added && ensureAudio()) eng.trigger(ui.roll, ctx.currentTime, ui.vel, m, Math.min(0.6, ui.len * C.stepDuration(P.bpm)));
    commit(); renderRoll(); paintSeq();
  }

  // ---------- mixer ----------
  function buildMixer() {
    const box = $('#mixer');
    box.innerHTML = C.TRACKS.map((t) => `<div class="strip" data-track="${t.id}" style="--h:${t.hue}">
      <div class="sh"><b>${t.name}</b><span><button class="ms m" data-act="mute">M</button><button class="ms s" data-act="solo">S</button></span></div>
      ${[['vol', 'Vol', 0, 1], ['pan', 'Pan', -1, 1], ['cutoff', 'Filter', 0, 1], ['reverb', 'Reverb', 0, 1], ['delay', 'Delay', 0, 1]].map(([k, l, lo, hi]) =>
        `<label class="knob"><span>${l}</span><input type="range" data-k="${k}" min="${lo}" max="${hi}" step="0.01"></label>`).join('')}
    </div>`).join('');
    paintMixer();
  }
  function paintMixer() {
    for (const st of $$('#mixer .strip')) {
      const m = P.mixer[st.dataset.track];
      $$('input', st).forEach((i) => { if (document.activeElement !== i) i.value = m[i.dataset.k]; });
      $('.m', st).classList.toggle('on', m.mute); $('.s', st).classList.toggle('on', m.solo);
      st.classList.toggle('muted', !C.isAudible(P.mixer, st.dataset.track));
    }
    $('#master').value = P.master; $('#masterOut').textContent = Math.round(P.master * 100) + '%';
  }
  function mixChanged(noCommit) { if (eng) eng.applyMixer(P, true); paintMixer(); paintSeq(); if (!noCommit) commit(); }

  // ---------- song ----------
  function renderChain() {
    $('#chain').innerHTML = P.song.map((p, i) => `<button class="chip${ui.playing && P.songMode && ui.songIdx === i ? ' now' : ''}" data-i="${i}" title="Remove">${p}<span>×</span></button>`).join('') || '<span class="muted">Empty</span>';
    $('#copyFrom').textContent = P.current;
  }

  // ---------- header / controls ----------
  function paintControls() {
    $('#projName').value = P.name;
    $('#bpm').value = P.bpm; $('#bpmRange').value = P.bpm;
    $('#swing').value = Math.round(P.swing * 100); $('#swingOut').textContent = Math.round(P.swing * 100) + '%';
    $('#keySel').value = P.key; $('#scaleSel').value = P.scale; $('#songMode').checked = P.songMode;
    $$('[data-steps]').forEach((b) => b.classList.toggle('on', +b.dataset.steps === P.steps));
    $$('[data-vel]').forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.vel - ui.vel) < 0.01));
    $$('[data-len]').forEach((b) => b.classList.toggle('on', +b.dataset.len === ui.len));
    $('#undoBtn').disabled = !hist.canUndo; $('#redoBtn').disabled = !hist.canRedo;
  }
  function renderAll() { paintControls(); buildSeq(); renderRollTracks(); renderRoll(); paintMixer(); renderChain(); if (eng) eng.applyMixer(P, true); if (clock) { clock.setBpm(P.bpm); clock.setSwing(P.swing); } }

  let saveTimer = null;
  function commit(repaint) {
    const s = JSON.stringify(P);
    if (hist.commit(s)) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, s); } catch (e) { /* storage full or blocked */ } }, 300); }
    $('#undoBtn').disabled = !hist.canUndo; $('#redoBtn').disabled = !hist.canRedo;
    if (repaint) renderAll();
  }
  function restore(snap) { if (snap == null) return; P = C.normalizeProject(JSON.parse(snap)); try { localStorage.setItem(LS_KEY, snap); } catch (e) { /* ignore */ } renderAll(); }
  const undo = () => restore(hist.undo());
  const redo = () => restore(hist.redo());
  function setProject(p, msg) { P = C.normalizeProject(p); commit(); renderAll(); if (msg) toast(msg); }
  function loadAutosave() { try { const s = localStorage.getItem(LS_KEY); return s ? C.parseProject(s) : null; } catch (e) { return null; } }

  function setBpm(v, doCommit) { P.bpm = C.clampBpm(v); if (clock) clock.setBpm(P.bpm); if (eng) eng.setTempo(P.bpm); $('#bpm').value = P.bpm; $('#bpmRange').value = P.bpm; if (doCommit) commit(); }
  function tap() {
    const now = performance.now() / 1000; ui.taps.push(now); ui.taps = ui.taps.slice(-12);
    const b = C.tapTempo(ui.taps); const btn = $('#tapBtn'); btn.classList.remove('hit'); void btn.offsetWidth; btn.classList.add('hit');
    if (b) setBpm(b, true);
  }
  function setSteps(n) {
    if (n === P.steps) return;
    if (n === 32) for (const id of C.PATTERN_IDS) { // grow: repeat bar 1 into bar 2 when bar 2 is empty
      const pat = P.patterns[id];
      for (const d of C.DRUM_IDS) if (pat.d[d].slice(16).every((v) => !v)) for (let i = 0; i < 16; i++) pat.d[d][16 + i] = pat.d[d][i];
      for (const s of C.SYNTH_IDS) if (!pat.m[s].some((x) => x.s >= 16)) pat.m[s] = pat.m[s].concat(pat.m[s].filter((x) => x.s < 16).map((x) => Object.assign({}, x, { s: x.s + 16 })));
    }
    P.steps = n; commit(); renderAll();
  }
  function setKeyScale(key, scale) {
    const oldKey = P.key; P.key = key; P.scale = scale;
    // Moving key transposes melodies; changing scale snaps them into the new scale.
    const shift = ((key - oldKey) % 12 + 12) % 12; const d = shift > 6 ? shift - 12 : shift;
    for (const id of C.PATTERN_IDS) { const pat = P.patterns[id]; for (const s of C.SYNTH_IDS) pat.m[s].forEach((n) => (n.n = C.clamp(n.n + d, 0, 127))); if (ui.lock) C.snapPatternToScale(pat, key, scale); }
    commit(); renderAll();
  }

  // ---------- export ----------
  async function renderWav(opts) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('Offline rendering is not supported in this browser');
    const r = C.renderEvents(P, opts), sr = 44100, secs = r.seconds + 2.5;
    const off = new OAC(2, Math.ceil(sr * secs), sr);
    const e2 = SY.createEngine(off); e2.applyMixer(P, false);
    for (const ev of r.events) e2.trigger(ev.track, ev.time + 0.02, ev.vel, ev.midi, ev.dur);
    const buf = await new Promise((res, rej) => { off.oncomplete = (e) => res(e.renderedBuffer); const p = off.startRendering(); if (p && p.then) p.then(res, rej); });
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    return { wav: C.encodeWAV(chans, sr), rms: C.rms(chans), peak: C.peak(chans), seconds: secs, events: r.events.length };
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  const fileBase = () => (P.name || 'beat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'beat';
  function expOpts() { return { range: $('#expRange').value, loops: +$('#expLoops').value }; }
  function updateExpInfo() { const r = C.renderEvents(P, expOpts()); $('#expInfo').textContent = `${r.totalSteps} steps at ${P.bpm} BPM ≈ ${(r.seconds + 2.5).toFixed(1)} s (incl. 2.5 s tail) · 44.1 kHz stereo 16-bit`; }
  let rec = null;
  async function exportWav() {
    const st = $('#expStatus'); st.textContent = 'Rendering…'; $('#wavBtn').disabled = true;
    try {
      const out = await renderWav(expOpts());
      if (out.rms < 1e-5) { st.textContent = 'Nothing to hear: the pattern is empty or every track is muted.'; return; }
      download(new Blob([out.wav], { type: 'audio/wav' }), fileBase() + '.wav');
      st.textContent = `Saved ${fileBase()}.wav (${(out.wav.byteLength / 1048576).toFixed(1)} MB, ${out.seconds.toFixed(1)} s).`;
    } catch (e) { st.textContent = 'Export failed: ' + e.message; } finally { $('#wavBtn').disabled = false; }
  }
  function toggleWebm() {
    const st = $('#expStatus'), btn = $('#webmBtn');
    if (rec) { rec.stop(); return; }
    if (!window.MediaRecorder || !ensureAudio() || !ctx.createMediaStreamDestination) { st.textContent = 'Live recording is not supported in this browser. Use WAV instead.'; return; }
    const dest = ctx.createMediaStreamDestination(); eng.limiter.connect(dest);
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const chunks = []; rec = new MediaRecorder(dest.stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { eng.limiter.disconnect(dest); const ext = (rec.mimeType || type).includes('mp4') ? 'm4a' : (rec.mimeType || type).includes('ogg') ? 'ogg' : 'webm';
      download(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }), fileBase() + '.' + ext); rec = null; btn.textContent = 'Record live (WebM)'; btn.classList.remove('recording'); st.textContent = 'Saved live recording.'; stop(); };
    stop(); P.songMode = $('#expRange').value === 'song'; paintControls();
    rec.start(); play(); btn.textContent = 'Stop & save'; btn.classList.add('recording'); st.textContent = 'Recording the live output… press Stop & save when done.';
  }

  // ---------- projects ----------
  function saves() { try { return JSON.parse(localStorage.getItem(LS_SAVES) || '[]'); } catch (e) { return []; } }
  function renderSaves() {
    const s = saves();
    $('#savedList').innerHTML = s.length ? s.map((x, i) => `<li><span>${esc(x.name)}<small>${new Date(x.at).toLocaleString()}</small></span><button type="button" class="btn small" data-load="${i}">Load</button><button type="button" class="btn small ghost" data-del="${i}" aria-label="Delete">✕</button></li>`).join('') : '<li class="muted">No saved projects yet.</li>';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- misc UI ----------
  let toastT = null;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
  function showTab(name) { ui.tab = name; $$('[role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name)); $$('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + name)); }
  function selectPattern(id) { if (!C.PATTERN_IDS.includes(id)) return; P.current = id; commit(); paintSeq(); renderRoll(); renderChain(); paintPlayhead(); }

  function wire() {
    $('#keySel').innerHTML = C.NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
    $('#scaleSel').innerHTML = Object.keys(C.SCALES).map((k) => `<option value="${k}">${C.SCALE_LABELS[k]}</option>`).join('');
    $('#presetSel').innerHTML = '<option value="">Demo beats…</option>' + PR.LIST.map(([id, n]) => `<option value="${id}">${n}</option>`).join('');

    $('#playBtn').addEventListener('click', toggle);
    $('#recBtn').addEventListener('click', () => { ui.recording = !ui.recording; $('#recBtn').classList.toggle('on', ui.recording); $('#recBtn').setAttribute('aria-pressed', ui.recording); if (ui.recording) { toast('Recording: pad hits are quantized into the pattern'); play(); } });
    $('#bpm').addEventListener('change', (e) => setBpm(e.target.value, true));
    $('#bpmRange').addEventListener('input', (e) => setBpm(e.target.value, false));
    $('#bpmRange').addEventListener('change', () => commit());
    $('#tapBtn').addEventListener('click', tap);
    $('#swing').addEventListener('input', (e) => { P.swing = C.clampSwing(e.target.value / 100); if (clock) clock.setSwing(P.swing); $('#swingOut').textContent = e.target.value + '%'; });
    $('#swing').addEventListener('change', () => commit());
    $('#projName').addEventListener('change', (e) => { P.name = e.target.value.trim().slice(0, 80) || 'Untitled beat'; commit(); });
    $('#undoBtn').addEventListener('click', undo); $('#redoBtn').addEventListener('click', redo);
    $('#presetSel').addEventListener('change', (e) => { const id = e.target.value; e.target.value = ''; if (!id) return; const playing = ui.playing; stop(); setProject(PR.build(id), 'Loaded ' + PR.DEFS[id].name); if (playing) play(); });
    $('#keySel').addEventListener('change', (e) => setKeyScale(+e.target.value, P.scale));
    $('#scaleSel').addEventListener('change', (e) => setKeyScale(P.key, e.target.value));
    $$('.pat').forEach((b) => b.addEventListener('click', () => selectPattern(b.dataset.pat)));
    $$('[data-steps]').forEach((b) => b.addEventListener('click', () => setSteps(+b.dataset.steps)));
    $$('[data-vel]').forEach((b) => b.addEventListener('click', () => { ui.vel = +b.dataset.vel; paintControls(); }));
    $$('[data-len]').forEach((b) => b.addEventListener('click', () => { ui.len = +b.dataset.len; paintControls(); }));
    $('#songMode').addEventListener('change', (e) => { P.songMode = e.target.checked; commit(); renderChain(); });
    $('#clearBtn').addEventListener('click', () => { P.patterns[P.current] = C.emptyPattern(); commit(); paintSeq(); renderRoll(); toast('Pattern ' + P.current + ' cleared (Ctrl+Z to undo)'); });

    const seq = $('#seq');
    seq.addEventListener('click', (e) => { if (longPressed) { longPressed = false; return; } onSeqClick(e, false); });
    seq.addEventListener('contextmenu', (e) => { if (e.target.closest('.cell')) { e.preventDefault(); if (!lpFired) onSeqClick(e, true); lpFired = false; } });
    // Long-press to cycle velocity on touch screens that don't send contextmenu (iOS).
    let lpTimer = null, longPressed = false, lpFired = false;
    seq.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch' || !e.target.closest('.cell')) return; const ev = e; lpTimer = setTimeout(() => { longPressed = true; lpFired = true; onSeqClick(ev, true); setTimeout(() => (lpFired = false), 600); }, 480); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((n) => seq.addEventListener(n, () => clearTimeout(lpTimer)));

    $('#roll').addEventListener('click', onRollClick);
    $('#rollTracks').addEventListener('click', (e) => { const b = e.target.closest('[data-roll]'); if (!b) return; ui.roll = b.dataset.roll; renderRollTracks(); renderRoll(); paintSeq(); });
    $('#scaleLock').addEventListener('change', (e) => { ui.lock = e.target.checked; if (ui.lock) { let n = 0; for (const id of C.PATTERN_IDS) n += C.snapPatternToScale(P.patterns[id], P.key, P.scale); if (n) { commit(); paintSeq(); toast(n + ' note(s) snapped to the scale'); } } renderRoll(); });
    $$('[role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    const mixer = $('#mixer');
    mixer.addEventListener('input', (e) => { const i = e.target; if (!i.dataset.k) return; const id = i.closest('.strip').dataset.track; P.mixer[id][i.dataset.k] = +i.value; if (eng) eng.applyMixer(P, true); });
    mixer.addEventListener('change', (e) => { if (e.target.dataset.k) commit(); });
    mixer.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (!b) return; const id = b.closest('.strip').dataset.track; P.mixer[id][b.dataset.act] = !P.mixer[id][b.dataset.act]; mixChanged(); });
    mixer.addEventListener('dblclick', (e) => { const i = e.target; if (!i.dataset || !i.dataset.k) return; const id = i.closest('.strip').dataset.track; P.mixer[id][i.dataset.k] = C.defaultMixer()[id][i.dataset.k]; mixChanged(); });
    $('#master').addEventListener('input', (e) => { P.master = +e.target.value; $('#masterOut').textContent = Math.round(P.master * 100) + '%'; if (eng) eng.applyMixer(P, true); });
    $('#master').addEventListener('change', () => commit());

    $('#chain').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; P.song.splice(+c.dataset.i, 1); if (!P.song.length) P.song = ['A']; commit(); renderChain(); });
    $$('[data-add]').forEach((b) => b.addEventListener('click', () => { if (P.song.length < 64) P.song.push(b.dataset.add); commit(); renderChain(); }));
    $('#chainPop').addEventListener('click', () => { if (P.song.length > 1) P.song.pop(); commit(); renderChain(); });
    $('#chainClear').addEventListener('click', () => { P.song = [P.current]; commit(); renderChain(); });
    $$('[data-copy]').forEach((b) => b.addEventListener('click', () => { const to = b.dataset.copy; if (to === P.current) return; P.patterns[to] = JSON.parse(JSON.stringify(P.patterns[P.current])); commit(); paintSeq(); toast(`Copied ${P.current} → ${to}`); }));

    // dialogs
    const openDlg = (d) => { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
    $('#exportBtn').addEventListener('click', () => { $('#expRange').value = P.songMode ? 'song' : 'pattern'; updateExpInfo(); $('#expStatus').textContent = ''; openDlg($('#exportDlg')); });
    $('#expRange').addEventListener('change', updateExpInfo); $('#expLoops').addEventListener('change', updateExpInfo);
    $('#wavBtn').addEventListener('click', exportWav); $('#webmBtn').addEventListener('click', toggleWebm);
    $('#projBtn').addEventListener('click', () => { renderSaves(); openDlg($('#projDlg')); });
    $('#saveLocal').addEventListener('click', () => { const s = saves().filter((x) => x.name !== P.name); s.unshift({ name: P.name, at: Date.now(), data: C.serializeProject(P) }); try { localStorage.setItem(LS_SAVES, JSON.stringify(s.slice(0, 30))); toast('Saved “' + P.name + '”'); } catch (e) { toast('Browser storage is full or blocked'); } renderSaves(); });
    $('#savedList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const s = saves();
      if (b.dataset.load != null) { const x = s[+b.dataset.load]; if (x) { stop(); setProject(C.parseProject(x.data), 'Loaded “' + x.name + '”'); $('#projDlg').close(); } }
      if (b.dataset.del != null) { s.splice(+b.dataset.del, 1); localStorage.setItem(LS_SAVES, JSON.stringify(s)); renderSaves(); } });
    $('#newProj').addEventListener('click', () => { stop(); setProject(C.defaultProject(), 'New project (Ctrl+Z to go back)'); $('#projDlg').close(); });
    $('#dlJson').addEventListener('click', () => download(new Blob([JSON.stringify(C.normalizeProject(P), null, 1)], { type: 'application/json' }), fileBase() + '.sbs.json'));
    $('#openJson').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { stop(); setProject(C.parseProject(await f.text()), 'Opened ' + f.name); $('#projDlg').close(); } catch (err) { toast(err.message); } });
    $('#shareBtn').addEventListener('click', () => { const url = location.href.split('#')[0] + '#b=' + C.encodeShare(P); $('#shareUrl').value = url; $('#shareStatus').textContent = url.length > 2000 ? 'This link is long; some apps may cut it off. Use Projects → Download .json for big songs.' : ''; openDlg($('#shareDlg')); $('#shareUrl').select(); });
    $('#copyShare').addEventListener('click', async () => { const u = $('#shareUrl').value; try { await navigator.clipboard.writeText(u); $('#shareStatus').textContent = 'Link copied.'; } catch (e) { $('#shareUrl').select(); document.execCommand && document.execCommand('copy'); $('#shareStatus').textContent = 'Select the link and copy it.'; } });

    // keyboard
    const keyMap = Object.fromEntries(C.TRACKS.map((t) => [t.key, t.id]));
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type) || tag === 'select' || tag === 'textarea' || document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); return; }
      if (e.repeat) return;
      if (keyMap[k] && !e.shiftKey) { e.preventDefault(); hitPad(keyMap[k], 1); return; }
      if (k === 't') tap();
      else if (e.shiftKey && k === 'r') $('#recBtn').click();
      else if (['5', '6', '7', '8'].includes(k)) selectPattern(C.PATTERN_IDS[+k - 5]);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running' && ui.playing) ctx.resume(); });
  }

  function loadFromHash() {
    const m = location.hash.match(/^#b=([\w-]+)/); if (!m) return false;
    try { P = C.decodeShare(m[1]); hist.reset(JSON.stringify(P)); commit(); toast('Loaded a shared beat. Press play!'); }
    catch (e) { toast('That share link could not be read.'); }
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  buildPads(); buildMixer(); wire(); loadFromHash(); renderAll();
  if (!localStorage.getItem(LS_KEY)) try { localStorage.setItem(LS_KEY, JSON.stringify(P)); } catch (e) { /* ignore */ }

  if ('serviceWorker' in navigator && location.protocol === 'https:') window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

  // Small hook for automated checks and power users (read-mostly).
  window.SBS = {
    get project() { return P; }, get playing() { return ui.playing; }, get playStep() { return ui.playStep; }, get audioState() { return ctx ? ctx.state : 'none'; },
    play, stop, undo, redo, renderWav, loadPreset: (id) => setProject(PR.build(id)), selectPattern,
    stepOn: (track, s) => P.patterns[P.current].d[track][s],
  };
})();
