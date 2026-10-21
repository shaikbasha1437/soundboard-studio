# SoundBoard Studio 🎛️

**A beat maker that runs entirely in your browser.** Tap pads, build loops in a step sequencer, layer drums with bass, leads and pads, then export your track as a WAV file. Every sound is synthesized live with the Web Audio API, so there are no sample files, no account, no server, and it works offline.

**Live app:** https://shaikbasha1437.github.io/soundboard-studio/

## Features

- **4×4 pad grid** you can play by click, tap or keyboard (`1-4`, `Q-R`, `A-F`, `Z-V`). There are 12 drums (kick, snare, clap, rim, closed and open hat with choke, shaker, cowbell, three toms, conga) and 4 melodic instruments (bass synth, lead, pluck, pad).
- **Step sequencer** with 16 or 32 steps and 16 tracks. Velocity is per step: pick 100/70/40 for new steps, and right-click or long-press a step to cycle it. Set BPM from 60 to 200, swing from 0 to 75%, and use tap tempo (`T`).
- **Tight timing:** a look-ahead scheduler ([Chris Wilson's "A Tale of Two Clocks"](https://web.dev/articles/audio-scheduling)) driven by a Web Worker timer. Step times are computed from a fixed anchor instead of being added up, so the beat doesn't drift. Tempo changes don't cause a jump.
- **Piano roll** for each melodic track, with **scale lock** (major, minor, major/minor pentatonic or chromatic) and a key picker. Changing the key transposes your melodies, and changing the scale snaps them into it. You can choose note lengths of 1, 2, 4 or 8 steps.
- **Mixer:** each track has volume, pan, mute/solo, a low-pass filter, reverb send and delay send (a tempo-synced dotted 8th). The master volume feeds a limiter with a gain-reduction meter. Double-click a slider to reset it.
- **Patterns A-D** and a **song chain**. Copy patterns, chain them, and switch on *Song* to play the arrangement.
- **Undo/redo** for every edit (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Demo beats:** boom bap hip-hop, deep house, lo-fi study and trap.
- **Live record:** press *Rec* while playing and your pad hits are quantized (with swing taken into account) into the pattern.
- **Export:** *Download WAV* renders offline with `OfflineAudioContext`, faster than real time, as 44.1 kHz 16-bit stereo, for a pattern or the whole song with 1-8 repeats. *Record live* captures the real-time output with `MediaRecorder` (WebM/Opus, or M4A on Safari).
- **Save & share:** your work autosaves. You can also save named projects in the browser, download or open `.json` project files, or copy a share link that stores the current pattern in the URL hash.
- **Mobile friendly:** touch pads, horizontally scrolling grids and first-tap audio unlock for iOS. It's an installable **PWA** with a network-first service worker that caches each file under a versioned cache and falls back to the cached app when you're offline.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / stop |
| `1-4`, `Q W E R`, `A S D F`, `Z X C V` | Play pads |
| `T` | Tap tempo |
| `Shift+R` | Toggle live record |
| `5 6 7 8` | Select pattern A-D |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Undo / redo |

## Good to know

- Audio can only start after you tap or press a key; that's a browser rule. If the browser blocks audio, SoundBoard Studio tells you.
- Share links hold only the current pattern, tempo, key and mix. To share whole songs, use *Projects → Download .json*.
- Sounds are synthesized, so exports are always the same, but the timbre may differ slightly between browsers.
- Live (WebM) recording needs `MediaRecorder` support. WAV export works in all modern browsers.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # sequencing, swing, serialization and WAV tests (Node 18+)
```

There are no dependencies and no build step. The pure logic is in `core.js` (timing, scales, project model, share links, undo, WAV encoder), the sounds are in `synth.js`, the demo beats are in `presets.js`, and the UI is in `app.js`.

## Tests

`test/core.test.js` covers:

- the step duration and BPM clamp
- swing offsets, including triplet feel
- that the look-ahead clock emits every step exactly once with no drift over 10,000 steps under a jittery timer
- tempo changes mid-play and recovery after a stalled tab
- swing-aware quantization and tap tempo
- scales and snapping, and song-chain position
- offline render events, including mute and solo
- editing helpers
- project JSON round-trip and validation, and share-link round-trip
- undo/redo limits
- the WAV header layout, sample round-trip and RMS
- that every demo beat is in key and has sound

## License

MIT, see `LICENSE`.
