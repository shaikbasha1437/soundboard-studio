/* SoundBoard Studio synth engine. Every sound is synthesized with Web Audio; no sample files.
   The same engine runs on a live AudioContext and on an OfflineAudioContext (WAV export). */
(function (root) {
  'use strict';
  const C = root.SBSCore;

  // Deterministic noise so offline renders are repeatable.
  function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }
  function noiseBuffer(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0), r = seeded(1234);
    for (let i = 0; i < len; i++) d[i] = r();
    return b;
  }
  function impulse(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c), r = seeded(99 + c * 7); for (let i = 0; i < len; i++) d[i] = r() * Math.pow(1 - i / len, decay); }
    return b;
  }
  const cutoffHz = (x) => 60 * Math.pow(20000 / 60, Math.min(1, Math.max(0, x)));
  const E = 0.0001;

  function createEngine(ctx) {
    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.15;
    master.connect(limiter); limiter.connect(ctx.destination);

    const reverb = ctx.createConvolver(); reverb.buffer = impulse(ctx, 2.4, 3);
    const revRet = ctx.createGain(); revRet.gain.value = 0.8; reverb.connect(revRet); revRet.connect(master);
    const delayIn = ctx.createGain(), delay = ctx.createDelay(2), fb = ctx.createGain(), dTone = ctx.createBiquadFilter(), delRet = ctx.createGain();
    dTone.type = 'lowpass'; dTone.frequency.value = 3500; fb.gain.value = 0.38; delRet.gain.value = 0.7;
    delayIn.connect(delay); delay.connect(dTone); dTone.connect(fb); fb.connect(delay); dTone.connect(delRet); delRet.connect(master);
    const noise = noiseBuffer(ctx, 1.5);

    const ch = {};
    for (const t of C.TRACKS) {
      const input = ctx.createGain(), filter = ctx.createBiquadFilter(), vol = ctx.createGain();
      filter.type = 'lowpass'; filter.Q.value = 0.8; filter.frequency.value = 20000;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      const rs = ctx.createGain(), ds = ctx.createGain(); rs.gain.value = 0; ds.gain.value = 0;
      input.connect(filter); filter.connect(vol); vol.connect(pan); pan.connect(master); pan.connect(rs); rs.connect(reverb); pan.connect(ds); ds.connect(delayIn);
      ch[t.id] = { input, filter, vol, pan, rs, ds };
    }
    const eng = { ctx, master, limiter, ch, openHat: null, mono: {} };

    eng.applyMixer = function (p, smooth) {
      const now = ctx.currentTime, tc = smooth ? 0.02 : 0;
      const set = (param, v) => { if (tc) param.setTargetAtTime(v, now, tc); else param.setValueAtTime(v, now); };
      for (const t of C.TRACKS) {
        const m = p.mixer[t.id], c = ch[t.id];
        set(c.vol.gain, C.isAudible(p.mixer, t.id) ? m.vol * m.vol * 1.4 : 0);
        if (c.pan.pan) set(c.pan.pan, m.pan);
        set(c.filter.frequency, cutoffHz(m.cutoff));
        set(c.rs.gain, m.reverb * 0.9); set(c.ds.gain, m.delay * 0.8);
      }
      set(master.gain, p.master * p.master * 1.2);
      eng.setTempo(p.bpm);
    };
    eng.setTempo = function (bpm) { delay.delayTime.setValueAtTime(Math.min(1.9, 0.75 * 60 / bpm), ctx.currentTime); }; // dotted 8th

    // ---------- building blocks ----------
    function env(param, t, peak, a, d) { param.setValueAtTime(E, t); param.linearRampToValueAtTime(peak, t + a); param.exponentialRampToValueAtTime(E, t + a + d); }
    function gainAt(dest) { const g = ctx.createGain(); g.gain.value = 0; g.connect(dest); return g; }
    function osc(type, f, dest, t, stop) { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.connect(dest); o.start(t); o.stop(stop); return o; }
    function noiseSrc(dest, t, stop, offset) { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.connect(dest); s.start(t, offset || 0); s.stop(stop); return s; }
    function filt(type, f, q, dest) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(dest); return b; }

    const drums = {
      kick(d, t, v) {
        const g = gainAt(d); env(g.gain, t, v * 1.1, 0.002, 0.5);
        const o = osc('sine', 160, g, t, t + 0.6); o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
        const cg = gainAt(d); env(cg.gain, t, v * 0.35, 0.001, 0.02); osc('square', 1200, cg, t, t + 0.03);
      },
      snare(d, t, v) {
        const ng = gainAt(d); env(ng.gain, t, v * 0.7, 0.001, 0.2); noiseSrc(filt('highpass', 1200, 0.7, ng), t, t + 0.25, 0.1);
        const bg = gainAt(d); env(bg.gain, t, v * 0.55, 0.001, 0.1); const o = osc('triangle', 220, bg, t, t + 0.15); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
      },
      clap(d, t, v) {
        const bp = filt('bandpass', 1400, 1.2, d); const g = ctx.createGain(); g.connect(bp); g.gain.setValueAtTime(E, t);
        for (let i = 0; i < 3; i++) { const s = t + i * 0.011; g.gain.setValueAtTime(v * 1.4, s); g.gain.exponentialRampToValueAtTime(v * 0.25, s + 0.009); }
        g.gain.setValueAtTime(v * 1.3, t + 0.033); g.gain.exponentialRampToValueAtTime(E, t + 0.22); noiseSrc(g, t, t + 0.25, 0.3);
      },
      rim(d, t, v) {
        const g = gainAt(d); env(g.gain, t, v * 0.6, 0.001, 0.04); osc('triangle', 1700, g, t, t + 0.06);
        const ng = gainAt(d); env(ng.gain, t, v * 0.4, 0.001, 0.025); noiseSrc(filt('bandpass', 3000, 2, ng), t, t + 0.05, 0.5);
      },
      chh(d, t, v) {
        if (eng.openHat && eng.openHat.t <= t) { const og = eng.openHat.g.gain; og.cancelScheduledValues(t); og.setTargetAtTime(E, t, 0.008); eng.openHat = null; }
        const g = gainAt(d); env(g.gain, t, v * 0.5, 0.001, 0.05); noiseSrc(filt('highpass', 7500, 0.8, g), t, t + 0.08, 0.7);
      },
      ohh(d, t, v) {
        const g = gainAt(d); env(g.gain, t, v * 0.45, 0.002, 0.38); noiseSrc(filt('highpass', 6500, 0.8, g), t, t + 0.45, 0.9);
        eng.openHat = { g, t };
      },
      shaker(d, t, v) { const g = gainAt(d); g.gain.setValueAtTime(E, t); g.gain.linearRampToValueAtTime(v * 0.35, t + 0.018); g.gain.exponentialRampToValueAtTime(E, t + 0.1); noiseSrc(filt('bandpass', 6000, 1.5, g), t, t + 0.12, 1.1); },
      cowbell(d, t, v) {
        const bp = filt('bandpass', 820, 2.5, d); const g = ctx.createGain(); g.connect(bp); env(g.gain, t, v * 0.6, 0.001, 0.3);
        osc('square', 545, g, t, t + 0.35); osc('square', 815, g, t, t + 0.35);
      },
      tomlo(d, t, v) { tom(d, t, v, 110, 70); }, tommid(d, t, v) { tom(d, t, v, 160, 105); }, tomhi(d, t, v) { tom(d, t, v, 230, 150); },
      conga(d, t, v) { const g = gainAt(d); env(g.gain, t, v * 0.8, 0.001, 0.22); const o = osc('sine', 340, g, t, t + 0.3); o.frequency.exponentialRampToValueAtTime(280, t + 0.05); },
    };
    function tom(d, t, v, f0, f1) { const g = gainAt(d); env(g.gain, t, v * 0.9, 0.002, 0.42); const o = osc('sine', f0, g, t, t + 0.5); o.frequency.exponentialRampToValueAtTime(f1, t + 0.25); }

    function adsr(param, t, dur, peak, a, dcy, sus, rel) {
      param.setValueAtTime(E, t); param.linearRampToValueAtTime(peak, t + a);
      param.setTargetAtTime(peak * sus, t + a, dcy / 3);
      const off = t + Math.max(dur, a + 0.01); param.setTargetAtTime(E, off, rel / 4);
      return off + rel * 1.5;
    }
    const synths = {
      bass(d, t, v, m, dur) {
        const f = C.mtof(m); const g = gainAt(d); const end = adsr(g.gain, t, dur, v * 0.55, 0.004, 0.25, 0.7, 0.08);
        const lp = filt('lowpass', 300, 6, g); lp.frequency.setValueAtTime(f * 10, t); lp.frequency.exponentialRampToValueAtTime(Math.max(80, f * 2), t + 0.18);
        osc('sawtooth', f, lp, t, end); const sub = gainAt(lp); sub.gain.value = 0.8; osc('sine', f / 2, sub, t, end);
      },
      lead(d, t, v, m, dur) {
        const f = C.mtof(m); const g = gainAt(d); const end = adsr(g.gain, t, dur, v * 0.22, 0.01, 0.3, 0.6, 0.18);
        const lp = filt('lowpass', 3000, 2, g);
        const a = osc('sawtooth', f, lp, t, end); a.detune.value = -7; const b = osc('square', f, lp, t, end); b.detune.value = 7;
      },
      pluck(d, t, v, m, dur) {
        const f = C.mtof(m); const g = gainAt(d); env(g.gain, t, v * 0.4, 0.002, Math.min(0.9, 0.25 + dur));
        const lp = filt('lowpass', 800, 3, g); lp.frequency.setValueAtTime(Math.min(12000, f * 12), t); lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.2), t + 0.25);
        osc('sawtooth', f, lp, t, t + 1.2); osc('triangle', f * 2, lp, t, t + 1.2);
      },
      pad(d, t, v, m, dur) {
        const f = C.mtof(m); const g = gainAt(d); const end = adsr(g.gain, t, dur, v * 0.1, 0.35, 0.6, 0.85, 0.9);
        const lp = filt('lowpass', 1600, 0.6, g);
        for (const det of [-12, 0, 11]) { const o = osc('sawtooth', f, lp, t, end); o.detune.value = det; }
        osc('triangle', f / 2, lp, t, end);
      },
    };

    /** Play one hit. time in ctx seconds; vel 0..1; midi/dur only for synth tracks. */
    eng.trigger = function (track, time, vel, midi, dur) {
      const c = ch[track]; if (!c) return;
      const t = Math.max(time, ctx.currentTime);
      if (drums[track]) drums[track](c.input, t, vel);
      else if (synths[track]) synths[track](c.input, t, vel, midi == null ? C.rootNote(track, 0) : midi, dur || 0.25);
    };
    eng.reduction = () => { const r = limiter.reduction; return typeof r === 'number' ? r : (r && r.value) || 0; };
    return eng;
  }

  root.SBSSynth = { createEngine, cutoffHz };
})(typeof self !== 'undefined' ? self : this);
