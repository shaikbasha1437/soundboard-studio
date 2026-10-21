/* Demo beats. Drum rows use one character per step: X = 100%, x = 70%, o = 40%, . = off.
   Melodic notes are [step, semitones above the track's root in the project key, length in steps, velocity]. */
(function (root, factory) {
  const m = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.SBSCore);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.SBSPresets = m;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const V = { X: 1, x: 0.7, o: 0.4 };
  function pat(def, key) {
    const p = C.emptyPattern();
    for (const [id, row] of Object.entries(def.d || {})) {
      const s = row.replace(/\s+/g, '');
      for (let i = 0; i < s.length && i < C.MAX_STEPS; i++) p.d[id][i] = V[s[i]] || 0;
    }
    for (const [id, notes] of Object.entries(def.m || {})) {
      const root = C.rootNote(id, key);
      p.m[id] = notes.map(([s, off, l, v]) => ({ s, n: root + off, v: v || 0.85, l: l || 1 }));
    }
    return p;
  }
  function build(def) {
    const p = C.defaultProject();
    Object.assign(p, { name: def.name, bpm: def.bpm, swing: def.swing, steps: def.steps || 16, key: def.key, scale: def.scale, song: def.song, songMode: false, current: 'A' });
    for (const id of Object.keys(def.patterns)) p.patterns[id] = pat(def.patterns[id], def.key);
    for (const [id, m] of Object.entries(def.mixer || {})) Object.assign(p.mixer[id], m);
    return C.normalizeProject(p);
  }
  // Chord helpers (semitone offsets from the root)
  const chord = (s, l, offs, v) => offs.map((o) => [s, o, l, v || 0.6]);

  const DEFS = {
    hiphop: {
      name: 'Boom bap (hip-hop)', bpm: 90, swing: 0.36, key: 9, scale: 'minor', song: ['A', 'A', 'B', 'A'],
      mixer: { chh: { vol: 0.55, cutoff: 0.85 }, ohh: { vol: 0.5 }, bass: { vol: 0.75, cutoff: 0.55 }, pad: { vol: 0.42, reverb: 0.45 }, snare: { reverb: 0.18 }, pluck: { delay: 0.3, vol: 0.5 } },
      patterns: {
        A: { d: { kick: 'X.....xX..X.....', snare: '....X.......X...', chh: 'x.o.x.o.x.o.x.ox', rim: '..........o.....' },
          m: { bass: [[0, 0, 3], [6, 0, 1], [7, 0, 2], [10, 3, 3], [14, -2, 2]], pad: [...chord(0, 8, [0, 3, 7, 10]), ...chord(8, 8, [-4, 0, 3, 7])] } },
        B: { d: { kick: 'X.....xX..X..x..', snare: '....X.......X..o', chh: 'x.o.x.o.x.o.x.o.', ohh: '..............x.', clap: '............x...' },
          m: { bass: [[0, 0, 3], [6, 0, 1], [7, 0, 2], [10, 5, 2], [13, 3, 3]], pad: [...chord(0, 8, [-2, 2, 5, 8]), ...chord(8, 8, [-4, 0, 3, 7])],
            pluck: [[2, 0, 1], [4, 3, 1], [7, 7, 2], [11, 3, 1], [14, 0, 2]] } },
      },
    },
    house: {
      name: 'Deep house', bpm: 124, swing: 0.12, key: 5, scale: 'minor', song: ['A', 'A', 'B', 'B'],
      mixer: { kick: { vol: 0.9 }, chh: { vol: 0.5, pan: 0.2 }, ohh: { vol: 0.5, pan: -0.15 }, shaker: { vol: 0.4, pan: 0.35 }, pluck: { vol: 0.5, delay: 0.35, reverb: 0.2 }, bass: { vol: 0.75, cutoff: 0.6 }, pad: { vol: 0.35, reverb: 0.5 } },
      patterns: {
        A: { d: { kick: 'X...X...X...X...', clap: '....X.......X...', ohh: '..x...x...x...x.', chh: 'o.o.o.o.o.o.o.oo' },
          m: { bass: [[2, 0, 1], [6, 0, 1], [10, 0, 1], [13, 3, 1], [14, 0, 1]], pluck: [...chord(3, 1, [12, 15, 19], 0.55), ...chord(10, 1, [10, 15, 19], 0.55)] } },
        B: { d: { kick: 'X...X...X...X...', clap: '....X.......X...', ohh: '..x...x...x...x.', chh: 'o.o.o.o.o.o.o.oo', shaker: '.o.o.o.o.o.o.o.o', conga: '......o.......x.' },
          m: { bass: [[2, 0, 1], [6, 0, 1], [10, -4, 1], [13, -2, 1], [14, 0, 1]], pad: chord(0, 16, [0, 3, 7, 10], 0.5), pluck: [...chord(3, 1, [12, 15, 19], 0.55), ...chord(10, 1, [8, 12, 15], 0.55)] } },
      },
    },
    lofi: {
      name: 'Lo-fi study', bpm: 78, swing: 0.5, key: 0, scale: 'major', song: ['A', 'B', 'A', 'B'],
      mixer: { kick: { vol: 0.75, cutoff: 0.6 }, rim: { vol: 0.7, reverb: 0.25 }, chh: { vol: 0.4, cutoff: 0.6 }, shaker: { vol: 0.3 }, pad: { vol: 0.5, cutoff: 0.55, reverb: 0.55 }, pluck: { vol: 0.5, cutoff: 0.7, delay: 0.4, reverb: 0.3 }, bass: { vol: 0.6, cutoff: 0.45 } },
      patterns: {
        A: { d: { kick: 'X.......X.x.....', rim: '....X.......X...', chh: 'x.o.x.o.x.o.x.oo', shaker: '..o...o...o...o.' },
          m: { pad: [...chord(0, 8, [0, 4, 7, 11], 0.5), ...chord(8, 8, [9, 12, 16, 19], 0.5)], bass: [[0, 12, 4], [8, 9, 4], [12, 7, 2]],
            pluck: [[2, 16, 1], [3, 19, 1], [6, 23, 2], [10, 21, 1], [11, 19, 2]] } },
        B: { d: { kick: 'X.......X.x...o.', rim: '....X.......X...', chh: 'x.o.x.o.x.o.x.o.', shaker: '..o...o...o...o.', ohh: '..............o.' },
          m: { pad: [...chord(0, 8, [5, 9, 12, 16], 0.5), ...chord(8, 8, [7, 11, 14], 0.5)], bass: [[0, 17, 4], [8, 19, 4], [14, 11, 2]],
            pluck: [[2, 17, 1], [4, 16, 1], [6, 14, 2], [10, 19, 1], [12, 14, 2]] } },
      },
    },
    trap: {
      name: 'Trap', bpm: 140, swing: 0, key: 1, scale: 'minor', song: ['A', 'B', 'A', 'B'], steps: 32,
      mixer: { kick: { vol: 0.85 }, clap: { vol: 0.85, reverb: 0.15 }, chh: { vol: 0.5, pan: 0.15 }, ohh: { vol: 0.45 }, bass: { vol: 0.9, cutoff: 0.35 }, lead: { vol: 0.45, delay: 0.35, reverb: 0.3 } },
      patterns: {
        A: { d: { kick: 'X.........X.....  X.....X...X.....', clap: '........X.......  ........X.......',
          chh: 'X.x.X.x.XxXxX.x.  X.x.X.x.X.x.XXXX', ohh: '..............x.  ..............o.' },
          m: { bass: [[0, 0, 8], [10, 0, 6], [18, 0, 4], [22, 3, 4], [26, 10, 6]],
            lead: [[0, 12, 2], [4, 15, 2], [8, 19, 4], [16, 12, 2], [20, 15, 2], [24, 14, 4]] } },
        B: { d: { kick: 'X.........X.....  X.....X...X.X...', clap: '........X.......  ........X.......', snare: '..................................',
          chh: 'XxXxX.x.X.x.XXXX  X.x.X.x.XxXxX.x.', ohh: '......x.......x.  ......x.......x.', tomhi: '..........................x.....', tommid: '............................x...', tomlo: '..............................x.' },
          m: { bass: [[0, 0, 8], [10, 0, 6], [18, 8, 4], [22, 10, 4], [26, 0, 6]],
            lead: [[0, 12, 2], [4, 15, 2], [8, 20, 4], [16, 19, 2], [20, 15, 2], [24, 12, 4]] } },
      },
    },
  };
  const LIST = [['hiphop', 'Boom bap (hip-hop)'], ['house', 'Deep house'], ['lofi', 'Lo-fi study'], ['trap', 'Trap']];
  return { LIST, DEFS, build: (id) => build(DEFS[id]) };
});
