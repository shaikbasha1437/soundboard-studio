/* SoundBoard Studio core: pure logic shared by the app and the Node tests.
   Timing math, swing, scales, the project model, serialization, share links,
   song arrangement, undo history and a WAV encoder. No DOM or Web Audio here. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.SBSCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STEPS = 32;
  const PATTERN_IDS = ['A', 'B', 'C', 'D'];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const SCALE_LABELS = { major: 'Major', minor: 'Minor', pentatonic: 'Major pentatonic', minorPentatonic: 'Minor pentatonic', chromatic: 'Chromatic' };
  const BPM_MIN = 60, BPM_MAX = 200, SWING_MAX = 0.75;

  // 16 instruments = the 4x4 pad grid, in pad order (row by row).
  const TRACKS = [
    { id: 'kick', name: 'Kick', kind: 'drum', key: '1', hue: 190 },
    { id: 'snare', name: 'Snare', kind: 'drum', key: '2', hue: 205 },
    { id: 'clap', name: 'Clap', kind: 'drum', key: '3', hue: 220 },
    { id: 'rim', name: 'Rim', kind: 'drum', key: '4', hue: 235 },
    { id: 'chh', name: 'Closed hat', kind: 'drum', key: 'q', hue: 290 },
    { id: 'ohh', name: 'Open hat', kind: 'drum', key: 'w', hue: 300 },
    { id: 'shaker', name: 'Shaker', kind: 'drum', key: 'e', hue: 310 },
    { id: 'cowbell', name: 'Cowbell', kind: 'drum', key: 'r', hue: 320 },
    { id: 'tomlo', name: 'Low tom', kind: 'drum', key: 'a', hue: 25 },
    { id: 'tommid', name: 'Mid tom', kind: 'drum', key: 's', hue: 35 },
    { id: 'tomhi', name: 'High tom', kind: 'drum', key: 'd', hue: 45 },
    { id: 'conga', name: 'Conga', kind: 'drum', key: 'f', hue: 55 },
    { id: 'bass', name: 'Bass synth', kind: 'synth', key: 'z', hue: 95, base: 36 },
    { id: 'lead', name: 'Lead', kind: 'synth', key: 'x', hue: 120, base: 60 },
    { id: 'pluck', name: 'Pluck', kind: 'synth', key: 'c', hue: 145, base: 60 },
    { id: 'pad', name: 'Pad', kind: 'synth', key: 'v', hue: 165, base: 48 },
  ];
  const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));
  const DRUM_IDS = TRACKS.filter((t) => t.kind === 'drum').map((t) => t.id);
  const SYNTH_IDS = TRACKS.filter((t) => t.kind === 'synth').map((t) => t.id);
  const ROLL_SPAN = 24; // piano-roll range: base .. base + 2 octaves

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : (typeof x === 'string' && x.trim() !== '' && isFinite(+x) ? +x : d));
  const clampBpm = (b) => clamp(Math.round(num(b, 120) * 10) / 10, BPM_MIN, BPM_MAX);
  const clampSwing = (s) => clamp(num(s, 0), 0, SWING_MAX);

  // ---------- timing ----------
  /** Seconds per sequencer step (a 16th note). */
  function stepDuration(bpm) { return 60 / clampBpm(bpm) / 4; }
  /** Swing delays every odd (off-beat) 16th by swing * half a step. 0.667 ≈ triplet feel. */
  function swingOffset(n, stepDur, swing) { return (Math.abs(n) % 2 === 1) ? clampSwing(swing) * 0.5 * stepDur : 0; }
  /** Absolute time of step n. Computed from an anchor (never accumulated), so it can't drift. */
  function stepTime(n, anchor, stepDur, swing) { return anchor + n * stepDur + swingOffset(n, stepDur, swing); }

  /** Look-ahead clock (Chris Wilson's "A tale of two clocks" pattern), with injected time. */
  class Clock {
    constructor(bpm, swing) { this.dur = stepDuration(bpm); this.swing = clampSwing(swing); this.anchor = 0; this.n = 0; }
    start(t0) { this.anchor = t0; this.n = 0; }
    /** Change tempo without a jump: the next unscheduled step keeps its grid time. */
    setBpm(bpm) { const t = this.anchor + this.n * this.dur; this.dur = stepDuration(bpm); this.anchor = t - this.n * this.dur; }
    setSwing(s) { this.swing = clampSwing(s); }
    /** Every step whose grid time falls before now + lookahead, each returned once.
        If the tab stalled for a long time, skip the stale steps instead of firing a burst. */
    due(now, lookahead) {
      const out = [];
      for (let guard = 0; guard < 4096; guard++) {
        const base = this.anchor + this.n * this.dur;
        if (base >= now + lookahead) break;
        if (base < now - 0.25) { this.n += Math.max(1, Math.floor((now - base) / this.dur)); continue; }
        out.push({ n: this.n, time: base + swingOffset(this.n, this.dur, this.swing) });
        this.n++;
      }
      return out;
    }
    timeOf(n) { return stepTime(n, this.anchor, this.dur, this.swing); }
    /** Nearest (swing-aware) step to time t: used to quantize live-recorded hits. */
    nearestStep(t) {
      const f = Math.floor((t - this.anchor) / this.dur);
      let best = f, bd = Infinity;
      for (let n = f - 1; n <= f + 2; n++) { const d = Math.abs(this.timeOf(n) - t); if (d < bd) { bd = d; best = n; } }
      return best;
    }
  }

  /** Tap tempo: average of recent intervals (taps more than 2 s apart start over). */
  function tapTempo(taps) {
    const t = [];
    for (const x of taps) { if (t.length && x - t[t.length - 1] > 2) t.length = 0; t.push(x); }
    const recent = t.slice(-8);
    if (recent.length < 2) return null;
    const iv = [];
    for (let i = 1; i < recent.length; i++) iv.push(recent[i] - recent[i - 1]);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    if (!(avg > 0)) return null;
    return clamp(Math.round(60 / avg), BPM_MIN, BPM_MAX);
  }

  // ---------- scales ----------
  function inScale(midi, key, scale) { const s = SCALES[scale] || SCALES.chromatic; return s.includes(((midi - key) % 12 + 12) % 12); }
  function scaleNotes(key, scale, lo, hi) { const out = []; for (let m = lo; m <= hi; m++) if (inScale(m, key, scale)) out.push(m); return out; }
  /** Nearest note in the scale (ties go down). */
  function snapToScale(midi, key, scale) {
    for (let d = 0; d < 12; d++) { if (inScale(midi - d, key, scale)) return midi - d; if (inScale(midi + d, key, scale)) return midi + d; }
    return midi;
  }
  function noteName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function rootNote(trackId, key) { const t = TRACK_BY_ID[trackId]; return (t && t.base != null ? t.base : 48) + ((key % 12) + 12) % 12; }

  // ---------- project model ----------
  function emptyPattern() {
    const d = {}, m = {};
    for (const id of DRUM_IDS) d[id] = new Array(MAX_STEPS).fill(0);
    for (const id of SYNTH_IDS) m[id] = [];
    return { d, m };
  }
  function defaultMixer() {
    const mx = {};
    for (const t of TRACKS) mx[t.id] = { vol: t.kind === 'synth' ? 0.7 : 0.8, pan: 0, mute: false, solo: false, cutoff: 1, reverb: t.id === 'pad' ? 0.35 : 0, delay: 0 };
    return mx;
  }
  function defaultProject() {
    const patterns = {};
    for (const p of PATTERN_IDS) patterns[p] = emptyPattern();
    return { v: 1, name: 'Untitled beat', bpm: 120, swing: 0, steps: 16, key: 0, scale: 'minor', current: 'A', songMode: false, song: ['A'], master: 0.8, mixer: defaultMixer(), patterns };
  }
  const round3 = (x) => Math.round(x * 1000) / 1000;
  function normNote(n, maxSteps) {
    if (!n || typeof n !== 'object') return null;
    const s = Math.round(num(n.s, -1)); const midi = Math.round(num(n.n, -1));
    if (s < 0 || s >= maxSteps || midi < 0 || midi > 127) return null;
    return { s, n: midi, v: round3(clamp(num(n.v, 1), 0.05, 1)), l: clamp(Math.round(num(n.l, 1)), 1, MAX_STEPS) };
  }
  function normPattern(p) {
    const out = emptyPattern();
    if (!p || typeof p !== 'object') return out;
    for (const id of DRUM_IDS) {
      const src = p.d && Array.isArray(p.d[id]) ? p.d[id] : null;
      if (src) for (let i = 0; i < MAX_STEPS; i++) out.d[id][i] = round3(clamp(num(src[i], 0), 0, 1));
    }
    for (const id of SYNTH_IDS) {
      const src = p.m && Array.isArray(p.m[id]) ? p.m[id] : [];
      const seen = new Set();
      for (const n of src) { const x = normNote(n, MAX_STEPS); if (x && !seen.has(x.s + ':' + x.n)) { seen.add(x.s + ':' + x.n); out.m[id].push(x); } }
      out.m[id].sort((a, b) => a.s - b.s || a.n - b.n);
    }
    return out;
  }
  /** Validate and fill in anything missing; used for every load path (JSON, localStorage, presets). */
  function normalizeProject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not a SoundBoard Studio project');
    const p = defaultProject();
    if (typeof obj.name === 'string') p.name = obj.name.slice(0, 80) || p.name;
    p.bpm = clampBpm(obj.bpm);
    p.swing = round3(clampSwing(obj.swing));
    p.steps = Math.round(num(obj.steps, 16)) === 32 ? 32 : 16;
    p.key = ((Math.round(num(obj.key, 0)) % 12) + 12) % 12;
    p.scale = SCALES[obj.scale] ? obj.scale : 'minor';
    p.current = PATTERN_IDS.includes(obj.current) ? obj.current : 'A';
    p.songMode = !!obj.songMode;
    if (Array.isArray(obj.song)) { const s = obj.song.filter((x) => PATTERN_IDS.includes(x)).slice(0, 64); p.song = s.length ? s : ['A']; }
    p.master = round3(clamp(num(obj.master, 0.8), 0, 1));
    if (obj.mixer && typeof obj.mixer === 'object') {
      for (const t of TRACKS) {
        const m = obj.mixer[t.id]; if (!m || typeof m !== 'object') continue;
        const d = p.mixer[t.id];
        p.mixer[t.id] = { vol: round3(clamp(num(m.vol, d.vol), 0, 1)), pan: round3(clamp(num(m.pan, 0), -1, 1)), mute: !!m.mute, solo: !!m.solo,
          cutoff: round3(clamp(num(m.cutoff, 1), 0, 1)), reverb: round3(clamp(num(m.reverb, d.reverb), 0, 1)), delay: round3(clamp(num(m.delay, 0), 0, 1)) };
      }
    }
    if (obj.patterns && typeof obj.patterns === 'object') for (const id of PATTERN_IDS) p.patterns[id] = normPattern(obj.patterns[id]);
    return p;
  }
  function serializeProject(p) { return JSON.stringify(normalizeProject(p)); }
  function parseProject(text) { let o; try { o = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON'); } return normalizeProject(o); }
  function patternIsEmpty(pat) { return DRUM_IDS.every((id) => pat.d[id].every((v) => !v)) && SYNTH_IDS.every((id) => !pat.m[id].length); }

  /** Mute/solo: if any track is soloed, only soloed (and unmuted) tracks play. */
  function isAudible(mixer, id) {
    const anySolo = TRACKS.some((t) => mixer[t.id] && mixer[t.id].solo);
    const m = mixer[id]; if (!m || m.mute) return false;
    return anySolo ? !!m.solo : true;
  }

  // ---------- arrangement ----------
  /** Map an absolute step counter to the pattern + step being played. */
  function songPosition(n, p) {
    const steps = p.steps;
    const step = ((n % steps) + steps) % steps;
    if (!p.songMode || !p.song.length) return { pattern: p.current, step, idx: -1 };
    const idx = Math.floor(n / steps) % p.song.length;
    return { pattern: p.song[idx], step, idx };
  }
  /** Note events that start on one step of a pattern. */
  function stepEvents(pat, step, p) {
    const out = [];
    for (const id of DRUM_IDS) { const v = pat.d[id][step]; if (v > 0) out.push({ track: id, vel: v }); }
    for (const id of SYNTH_IDS) for (const n of pat.m[id]) if (n.s === step) out.push({ track: id, vel: n.v, midi: n.n, len: Math.min(n.l, MAX_STEPS) });
    return out;
  }
  /** Every event for an offline render, with absolute times from 0 (swing applied). */
  function renderEvents(p, opts) {
    opts = opts || {};
    const range = opts.range === 'song' ? 'song' : 'pattern';
    const loops = clamp(Math.round(num(opts.loops, 1)), 1, 16);
    const q = Object.assign({}, p, { songMode: range === 'song' });
    const totalSteps = (range === 'song' ? p.song.length : 1) * p.steps * loops;
    const sd = stepDuration(p.bpm);
    const events = [];
    for (let n = 0; n < totalSteps; n++) {
      const pos = songPosition(n, q);
      const t = stepTime(n, 0, sd, p.swing);
      for (const e of stepEvents(p.patterns[pos.pattern], pos.step, p)) {
        if (!isAudible(p.mixer, e.track)) continue;
        events.push(Object.assign({ time: t, n }, e, e.len ? { dur: e.len * sd * 0.95 } : {}));
      }
    }
    return { events, totalSteps, seconds: totalSteps * sd, stepDur: sd };
  }

  // ---------- editing helpers ----------
  /** Piano-roll toggle: remove a note at (step, midi) or one covering that cell, else add one. */
  function toggleNote(list, s, midi, v, l) {
    const i = list.findIndex((n) => n.n === midi && s >= n.s && s < n.s + n.l);
    if (i >= 0) { list.splice(i, 1); return false; }
    list.push({ s, n: midi, v: v, l: l }); list.sort((a, b) => a.s - b.s || a.n - b.n); return true;
  }
  /** Drum step tap: off -> paint velocity; different velocity -> paint velocity; same -> off. */
  function tapDrumStep(arr, s, paintVel) { const cur = arr[s]; arr[s] = (!cur) ? paintVel : (Math.abs(cur - paintVel) > 0.01 ? paintVel : 0); return arr[s]; }
  const VEL_LEVELS = [1, 0.7, 0.4];
  function cycleVelocity(v) { if (!v) return VEL_LEVELS[0]; const i = VEL_LEVELS.findIndex((x) => Math.abs(x - v) < 0.06); return VEL_LEVELS[(i + 1) % VEL_LEVELS.length]; }
  function snapPatternToScale(pat, key, scale) {
    let changed = 0;
    for (const id of SYNTH_IDS) {
      const seen = new Set(); const kept = [];
      for (const n of pat.m[id]) { const m = snapToScale(n.n, key, scale); if (m !== n.n) changed++; const k = n.s + ':' + m; if (!seen.has(k)) { seen.add(k); kept.push(Object.assign({}, n, { n: m })); } }
      pat.m[id] = kept;
    }
    return changed;
  }

  // ---------- share links ----------
  function b64urlEncode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlDecode(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  /** Compact link payload: tempo, key, the current pattern, mute/levels. Drums are digit strings (velocity 0-9). */
  function encodeShare(p) {
    const pat = p.patterns[p.current];
    const o = { v: 1, b: p.bpm, w: Math.round(p.swing * 100), s: p.steps, k: p.key, c: p.scale, d: {}, m: {}, x: {} };
    for (const id of DRUM_IDS) { const a = pat.d[id].slice(0, p.steps); if (a.some((v) => v > 0)) o.d[id] = a.map((v) => Math.round(v * 9)).join('').replace(/0+$/, ''); }
    for (const id of SYNTH_IDS) { const a = pat.m[id].filter((n) => n.s < p.steps); if (a.length) o.m[id] = a.map((n) => [n.s, n.n, Math.round(n.v * 9), n.l]); }
    for (const t of TRACKS) { const m = p.mixer[t.id]; const d = defaultMixer()[t.id]; const x = [];
      if (m.mute) x.push('m'); if (Math.abs(m.vol - d.vol) > 0.001) x.push('v' + Math.round(m.vol * 100)); if (m.pan) x.push('p' + Math.round(m.pan * 100));
      if (m.cutoff < 1) x.push('f' + Math.round(m.cutoff * 100)); if (Math.abs(m.reverb - d.reverb) > 0.001) x.push('r' + Math.round(m.reverb * 100)); if (m.delay) x.push('e' + Math.round(m.delay * 100));
      if (x.length) o.x[t.id] = x.join(','); }
    if (!Object.keys(o.x).length) delete o.x;
    return b64urlEncode(JSON.stringify(o));
  }
  function decodeShare(str) {
    const o = JSON.parse(b64urlDecode(str));
    if (!o || o.v !== 1) throw new Error('Unknown share link');
    const p = defaultProject();
    p.name = 'Shared beat'; p.bpm = clampBpm(o.b); p.swing = clampSwing(num(o.w, 0) / 100); p.steps = o.s === 32 ? 32 : 16;
    p.key = ((Math.round(num(o.k, 0)) % 12) + 12) % 12; p.scale = SCALES[o.c] ? o.c : 'minor';
    const pat = { d: {}, m: {} };
    for (const id of DRUM_IDS) { const s = (o.d && typeof o.d[id] === 'string') ? o.d[id] : ''; pat.d[id] = Array.from({ length: MAX_STEPS }, (_, i) => (/[0-9]/.test(s[i] || '') ? +s[i] / 9 : 0)); }
    for (const id of SYNTH_IDS) pat.m[id] = (o.m && Array.isArray(o.m[id]) ? o.m[id] : []).map((a) => Array.isArray(a) ? { s: a[0], n: a[1], v: num(a[2], 9) / 9, l: a[3] } : null);
    p.patterns.A = normPattern(pat);
    if (o.x && typeof o.x === 'object') for (const id of Object.keys(o.x)) { const m = p.mixer[id]; if (!m || typeof o.x[id] !== 'string') continue;
      for (const tok of o.x[id].split(',')) { const c = tok[0], v = num(tok.slice(1), NaN) / 100;
        if (c === 'm') m.mute = true; else if (!isFinite(v)) continue; else if (c === 'v') m.vol = clamp(v, 0, 1); else if (c === 'p') m.pan = clamp(v, -1, 1);
        else if (c === 'f') m.cutoff = clamp(v, 0, 1); else if (c === 'r') m.reverb = clamp(v, 0, 1); else if (c === 'e') m.delay = clamp(v, 0, 1); } }
    return normalizeProject(p);
  }

  // ---------- undo / redo ----------
  class History {
    constructor(limit) { this.limit = limit || 100; this.undoStack = []; this.redoStack = []; this.current = null; }
    reset(snap) { this.undoStack = []; this.redoStack = []; this.current = snap; }
    /** Record a new state; returns false when nothing changed. */
    commit(snap) {
      if (snap === this.current) return false;
      if (this.current != null) { this.undoStack.push(this.current); if (this.undoStack.length > this.limit) this.undoStack.shift(); }
      this.current = snap; this.redoStack = []; return true;
    }
    undo() { if (!this.undoStack.length) return null; this.redoStack.push(this.current); this.current = this.undoStack.pop(); return this.current; }
    redo() { if (!this.redoStack.length) return null; this.undoStack.push(this.current); this.current = this.redoStack.pop(); return this.current; }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
  }

  // ---------- WAV ----------
  /** 16-bit PCM WAV from planar Float32 channels. Returns an ArrayBuffer. */
  function encodeWAV(channels, sampleRate) {
    const nch = channels.length, len = channels[0].length, bytes = len * nch * 2;
    const buf = new ArrayBuffer(44 + bytes), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * nch * 2, true); dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
      const x = clamp(channels[c][i] || 0, -1, 1);
      dv.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true); o += 2;
    }
    return buf;
  }
  /** Parse a 16-bit PCM WAV (used by tests and live verification). */
  function decodeWAV(buf) {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
    if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a WAV file');
    const nch = dv.getUint16(22, true), sr = dv.getUint32(24, true), bits = dv.getUint16(34, true), bytes = dv.getUint32(40, true);
    const frames = bytes / (nch * 2); const ch = Array.from({ length: nch }, () => new Float32Array(frames));
    let o = 44; for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) { ch[c][i] = dv.getInt16(o, true) / 0x8000; o += 2; }
    return { channels: ch, sampleRate: sr, bits, numChannels: nch, frames };
  }
  function rms(channels) { let s = 0, n = 0; for (const c of channels) for (let i = 0; i < c.length; i++) { s += c[i] * c[i]; n++; } return n ? Math.sqrt(s / n) : 0; }
  function peak(channels) { let p = 0; for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; } return p; }

  return { MAX_STEPS, PATTERN_IDS, NOTE_NAMES, SCALES, SCALE_LABELS, TRACKS, TRACK_BY_ID, DRUM_IDS, SYNTH_IDS, ROLL_SPAN, BPM_MIN, BPM_MAX, SWING_MAX, VEL_LEVELS,
    clamp, clampBpm, clampSwing, stepDuration, swingOffset, stepTime, Clock, tapTempo,
    inScale, scaleNotes, snapToScale, noteName, mtof, rootNote,
    emptyPattern, defaultMixer, defaultProject, normalizeProject, serializeProject, parseProject, patternIsEmpty, isAudible,
    songPosition, stepEvents, renderEvents, toggleNote, tapDrumStep, cycleVelocity, snapPatternToScale,
    encodeShare, decodeShare, b64urlEncode, b64urlDecode, History, encodeWAV, decodeWAV, rms, peak };
});
