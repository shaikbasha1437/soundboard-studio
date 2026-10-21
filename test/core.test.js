// Tests for sequencing/timing math, swing, scales, serialization, share links, undo and the WAV encoder.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');
const PR = require('../presets.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, expected ${b} ± ${tol}`);

test('step duration is a 16th note and BPM is clamped to 60-200', () => {
  near(C.stepDuration(120), 0.125, 1e-12, '120 bpm');
  near(C.stepDuration(60), 0.25, 1e-12, '60 bpm');
  near(C.stepDuration(500), 60 / 200 / 4, 1e-12, 'clamped high');
  near(C.stepDuration(10), 0.25, 1e-12, 'clamped low');
  assert.strictEqual(C.clampBpm('90'), 90);
  assert.strictEqual(C.clampBpm(NaN), 120);
});

test('swing delays only odd steps, by swing x half a step', () => {
  const sd = 0.125;
  assert.strictEqual(C.swingOffset(0, sd, 0.5), 0);
  near(C.swingOffset(1, sd, 0.5), 0.03125, 1e-12, 'odd step');
  assert.strictEqual(C.swingOffset(2, sd, 0.5), 0);
  near(C.swingOffset(3, sd, 2), 0.75 * 0.5 * sd, 1e-12, 'swing clamped to 75%');
  // 66.7% swing gives a triplet feel: the off-beat 16th lands 2/3 through the 8th
  const t1 = C.stepTime(1, 0, sd, 2 / 3);
  near(t1 / (2 * sd), 2 / 3, 1e-9, 'triplet');
  // beats (even steps) never move
  for (let n = 0; n < 64; n += 2) near(C.stepTime(n, 1, sd, 0.6), 1 + n * sd, 1e-12, 'even step ' + n);
});

test('look-ahead clock: each step once, in order, no drift after 10,000 steps', () => {
  const clk = new C.Clock(137, 0.3); clk.start(0.05);
  const seen = []; let now = 0;
  // simulate an irregular 25 ms timer with jitter
  while (seen.length < 10000) { now += 0.025 + (seen.length % 7) * 0.001; for (const e of clk.due(now, 0.1)) seen.push(e); }
  seen.forEach((e, i) => assert.strictEqual(e.n, i));
  const sd = C.stepDuration(137);
  const last = seen[9999];
  near(last.time, C.stepTime(9999, 0.05, sd, 0.3), 1e-9, 'absolute time of step 9999');
  for (const e of seen) assert.ok(e.time < now + 0.1 + sd, 'never scheduled beyond the window');
});

test('clock tempo change keeps the next step on time and continues the grid', () => {
  const clk = new C.Clock(120, 0); clk.start(0);
  const a = clk.due(1.0, 0.1); // steps up to t < 1.1
  const nextN = clk.n; const expected = nextN * 0.125;
  clk.setBpm(60);
  const b = clk.due(expected + 0.001, 0);
  assert.strictEqual(b[0].n, nextN);
  near(b[0].time, expected, 1e-12, 'next step unchanged');
  const c = clk.due(expected + 0.26, 0);
  near(c[0].time, expected + 0.25, 1e-12, 'new step length');
  assert.ok(a.length > 0);
});

test('clock skips stale steps after a long stall instead of bursting', () => {
  const clk = new C.Clock(120, 0); clk.start(0);
  clk.due(0.1, 0.1);
  const burst = clk.due(30, 0.1);
  assert.ok(burst.length <= 3, 'got ' + burst.length);
  assert.ok(burst.every((e) => e.time >= 29.7));
});

test('quantize: nearest step is swing-aware', () => {
  const clk = new C.Clock(120, 0.5); clk.start(10);
  assert.strictEqual(clk.nearestStep(10.0), 0);
  assert.strictEqual(clk.nearestStep(10.06), 0);
  assert.strictEqual(clk.nearestStep(10.13), 1); // step 1 is swung to 10.15625
  assert.strictEqual(clk.nearestStep(10.17), 1);
  assert.strictEqual(clk.nearestStep(10.22), 2);
  assert.strictEqual(clk.nearestStep(9.98), 0);
});

test('tap tempo averages recent taps and resets after a pause', () => {
  assert.strictEqual(C.tapTempo([0]), null);
  assert.strictEqual(C.tapTempo([0, 0.5, 1, 1.5]), 120);
  assert.strictEqual(C.tapTempo([0, 0.5, 1, 10, 10.6, 11.2]), 100);
  assert.strictEqual(C.tapTempo([0, 0.1, 0.2]), 200);
  assert.strictEqual(C.tapTempo([0, 1.9]), 60);
});

test('scales, key picker and snapping', () => {
  assert.deepStrictEqual(C.scaleNotes(0, 'major', 60, 72), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepStrictEqual(C.scaleNotes(9, 'minor', 57, 69), [57, 59, 60, 62, 64, 65, 67, 69]);
  assert.deepStrictEqual(C.scaleNotes(7, 'pentatonic', 55, 67), [55, 57, 59, 62, 64, 67]);
  assert.strictEqual(C.snapToScale(61, 0, 'major'), 60); // C# -> C (tie goes down)
  assert.strictEqual(C.snapToScale(66, 0, 'pentatonic'), 67); // F# -> G
  assert.strictEqual(C.noteName(60), 'C4');
  near(C.mtof(69), 440, 1e-9); near(C.mtof(81), 880, 1e-9);
  assert.strictEqual(C.rootNote('bass', 9), 45);
});

test('song position follows the chain; pattern mode loops the current pattern', () => {
  const p = C.defaultProject(); p.song = ['A', 'B', 'B', 'D']; p.steps = 16; p.current = 'C';
  assert.deepStrictEqual(C.songPosition(5, p), { pattern: 'C', step: 5, idx: -1 });
  p.songMode = true;
  assert.deepStrictEqual(C.songPosition(0, p), { pattern: 'A', step: 0, idx: 0 });
  assert.deepStrictEqual(C.songPosition(17, p), { pattern: 'B', step: 1, idx: 1 });
  assert.deepStrictEqual(C.songPosition(63, p), { pattern: 'D', step: 15, idx: 3 });
  assert.deepStrictEqual(C.songPosition(64, p), { pattern: 'A', step: 0, idx: 0 });
  p.steps = 32;
  assert.deepStrictEqual(C.songPosition(40, p), { pattern: 'B', step: 8, idx: 1 });
});

test('render events: swing applied, mute/solo respected, song length', () => {
  const p = C.defaultProject(); p.bpm = 120; p.swing = 0.5;
  p.patterns.A.d.kick[0] = 1; p.patterns.A.d.chh[1] = 0.7; p.patterns.A.m.bass.push({ s: 4, n: 36, v: 0.8, l: 2 });
  p.patterns.B.d.snare[4] = 1;
  let r = C.renderEvents(p, { range: 'pattern', loops: 2 });
  assert.strictEqual(r.events.length, 6);
  near(r.seconds, 4, 1e-9, '2 bars of 16ths at 120');
  const hat = r.events.find((e) => e.track === 'chh');
  near(hat.time, 0.125 + 0.03125, 1e-12, 'swung hat');
  const bass = r.events.find((e) => e.track === 'bass');
  near(bass.dur, 2 * 0.125 * 0.95, 1e-12, 'note length');
  p.mixer.kick.mute = true;
  assert.strictEqual(C.renderEvents(p, {}).events.filter((e) => e.track === 'kick').length, 0);
  p.mixer.kick.mute = false; p.mixer.chh.solo = true;
  assert.deepStrictEqual([...new Set(C.renderEvents(p, {}).events.map((e) => e.track))], ['chh']);
  p.mixer.chh.solo = false; p.song = ['A', 'B'];
  r = C.renderEvents(p, { range: 'song' });
  assert.strictEqual(r.totalSteps, 32);
  const sn = r.events.find((e) => e.track === 'snare');
  near(sn.time, 20 * 0.125, 1e-12, 'snare in pattern B');
});

test('editing helpers: drum velocity taps, cycling, piano-roll toggle', () => {
  const a = new Array(32).fill(0);
  assert.strictEqual(C.tapDrumStep(a, 3, 1), 1);
  assert.strictEqual(C.tapDrumStep(a, 3, 0.4), 0.4); // different velocity replaces
  assert.strictEqual(C.tapDrumStep(a, 3, 0.4), 0); // same velocity turns off
  assert.strictEqual(C.cycleVelocity(0), 1); assert.strictEqual(C.cycleVelocity(1), 0.7); assert.strictEqual(C.cycleVelocity(0.7), 0.4); assert.strictEqual(C.cycleVelocity(0.4), 1);
  const list = [];
  assert.strictEqual(C.toggleNote(list, 0, 60, 1, 4), true);
  assert.strictEqual(C.toggleNote(list, 2, 60, 1, 1), false); // clicking inside the note removes it
  assert.strictEqual(list.length, 0);
  C.toggleNote(list, 4, 64, 1, 1); C.toggleNote(list, 0, 67, 1, 1);
  assert.deepStrictEqual(list.map((n) => n.s), [0, 4]);
});

test('project JSON round-trips and bad input is clamped or rejected', () => {
  const p = PR.build('house');
  const back = C.parseProject(C.serializeProject(p));
  assert.deepStrictEqual(back, C.normalizeProject(p));
  assert.throws(() => C.parseProject('not json'), /valid JSON/);
  assert.throws(() => C.parseProject('[1,2]'), /Not a SoundBoard/);
  const q = C.normalizeProject({ bpm: 999, swing: -1, steps: 7, key: 14, scale: 'weird', song: ['Z', 'B'], patterns: { A: { d: { kick: [5, -1, 'x'] }, m: { bass: [{ s: 99, n: 40 }, { s: 1, n: 40, v: 9, l: 100 }, { s: 1, n: 40 }] } } }, mixer: { pad: { vol: 3, pan: -7 } } });
  assert.strictEqual(q.bpm, 200); assert.strictEqual(q.swing, 0); assert.strictEqual(q.steps, 16); assert.strictEqual(q.key, 2); assert.strictEqual(q.scale, 'minor');
  assert.deepStrictEqual(q.song, ['B']);
  assert.deepStrictEqual(q.patterns.A.d.kick.slice(0, 3), [1, 0, 0]);
  assert.strictEqual(q.patterns.A.d.kick.length, 32);
  assert.deepStrictEqual(q.patterns.A.m.bass, [{ s: 1, n: 40, v: 1, l: 32 }]); // duplicates and out-of-range dropped
  assert.strictEqual(q.mixer.pad.vol, 1); assert.strictEqual(q.mixer.pad.pan, -1);
});

test('share link encodes the current pattern compactly and decodes back', () => {
  const p = PR.build('trap'); p.current = 'B'; p.mixer.ohh.mute = true; p.mixer.lead.delay = 0.5;
  const s = C.encodeShare(p);
  assert.match(s, /^[\w-]+$/);
  assert.ok(s.length < 1500, 'length ' + s.length);
  const q = C.decodeShare(s);
  assert.strictEqual(q.bpm, 140); assert.strictEqual(q.steps, 32); assert.strictEqual(q.key, p.key);
  for (const id of C.DRUM_IDS) q.patterns.A.d[id].forEach((v, i) => near(v, p.patterns.B.d[id][i], 0.06, id + ' step ' + i));
  assert.deepStrictEqual(q.patterns.A.m.bass.map((n) => [n.s, n.n, n.l]), p.patterns.B.m.bass.map((n) => [n.s, n.n, n.l]));
  assert.strictEqual(q.mixer.ohh.mute, true); near(q.mixer.lead.delay, 0.5, 0.01);
  assert.throws(() => C.decodeShare('%%%'));
});

test('undo/redo history', () => {
  const h = new C.History(3); h.reset('a');
  assert.strictEqual(h.commit('a'), false);
  h.commit('b'); h.commit('c');
  assert.strictEqual(h.undo(), 'b'); assert.strictEqual(h.undo(), 'a'); assert.strictEqual(h.undo(), null);
  assert.strictEqual(h.redo(), 'b');
  h.commit('x'); assert.strictEqual(h.redo(), null, 'new edit clears redo');
  h.commit('y'); h.commit('z'); h.commit('w');
  assert.strictEqual(h.undoStack.length, 3, 'limit respected');
});

test('WAV encoder writes a valid 16-bit PCM header and round-trips samples', () => {
  const sr = 44100, n = 4410;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5; R[i] = -L[i]; }
  L[0] = 1.5; R[0] = -1.5; // clipping
  const buf = C.encodeWAV([L, R], sr);
  assert.strictEqual(buf.byteLength, 44 + n * 4);
  const dv = new DataView(buf);
  const str = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  assert.strictEqual(str(0), 'RIFF'); assert.strictEqual(str(8), 'WAVE'); assert.strictEqual(str(12), 'fmt '); assert.strictEqual(str(36), 'data');
  assert.strictEqual(dv.getUint32(4, true), 36 + n * 4);
  assert.strictEqual(dv.getUint16(20, true), 1); assert.strictEqual(dv.getUint16(22, true), 2); assert.strictEqual(dv.getUint32(24, true), sr);
  assert.strictEqual(dv.getUint32(28, true), sr * 4); assert.strictEqual(dv.getUint16(32, true), 4); assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(dv.getInt16(44, true), 32767); assert.strictEqual(dv.getInt16(46, true), -32768);
  const d = C.decodeWAV(buf);
  assert.strictEqual(d.frames, n); assert.strictEqual(d.numChannels, 2);
  for (let i = 1; i < n; i += 97) { near(d.channels[0][i], L[i], 1 / 16000); near(d.channels[1][i], R[i], 1 / 16000); }
  near(C.rms([L.slice(1)]), 0.5 / Math.SQRT2, 0.002, 'sine RMS');
  assert.strictEqual(C.rms([new Float32Array(100)]), 0);
});

test('every demo beat loads, stays in key and range, and has sound', () => {
  for (const [id] of PR.LIST) {
    const p = PR.build(id);
    assert.ok(p.bpm >= 60 && p.bpm <= 200);
    const r = C.renderEvents(p, { range: 'song' });
    assert.ok(r.events.length > 50, id + ' events');
    for (const pid of p.song) assert.ok(!C.patternIsEmpty(p.patterns[pid]), id + ' pattern ' + pid);
    for (const t of C.SYNTH_IDS) for (const pid of C.PATTERN_IDS) for (const n of p.patterns[pid].m[t]) {
      assert.ok(C.inScale(n.n, p.key, p.scale), `${id} ${t} ${n.n} in scale`);
      const b = C.TRACK_BY_ID[t].base; assert.ok(n.n >= b && n.n <= b + C.ROLL_SPAN, `${id} ${t} ${n.n} in roll range`);
    }
  }
});
