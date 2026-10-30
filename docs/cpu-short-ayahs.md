# CPU short-ayah tracking and harness regressions

The browser CPU path now preserves every sufficiently supported ayah in an
accepted recognition window, rather than returning only its final verse to the
timing buffer. Each timestamp keeps the matcher's exact token-to-ayah ownership;
identical refrains are not independently realigned to the same audio occurrence.

Full one-word next ayahs are accepted only with an already confirmed, near-end
passage context. Global identification still requires multiple words and
confirmation. Once a passage is confirmed, up to twelve preceding observations
can recover short startup ayahs using exact evidence in that surah's preceding
40-token neighborhood. Silence, unfinished words, ambiguous refrains, and mere
sequence continuity do not create cues. Seeking clears these observations.

Next-ayah admission uses supported word onsets, not the previous greedy CTC
word's potentially window-long end. Previous word/highlight ends are capped at
the next cue. Forced word alignment remains display-only.

## Validation

After `npm run build`:

- `npm run test:local`: integrated matcher → tracker → timings → buffer
  regressions, including 112:2 inside a multi-ayah window, singleton 55:64,
  short startup recovery, sustained previous-word ends, and refrains.
- `npm run test:short-ayah-ui`: synthetic media-clock controls in the shimmed
  harness and the installed extension. Both display 112:2 for its 0.4-second
  interval. The native control also deliberately removes its upstream cue and
  verifies that the renderer does not invent it. No ASR/helper is used.
- `npm run test:short-ayah-audio`: production WASM-worker replay with four-second
  windows and one-second hops. Requires the existing evaluation corpus in
  `server/cache/cpu-evaluation/`; cached fixtures are not downloaded by this test.
  This is an integration replay, not an end-to-end YouTube download test.

Short-ayah fix replay results (first 32 seconds, before the onset refinement below):

| Recording | Before | After |
| --- | --- | --- |
| Sudais, surah 78 | Missing 78:1, 78:2, 78:5; 78:4 at 12.82s | Missing 78:1 only; 78:4 at 10.01s; 78:5 at 12.12s |
| Husary, surah 93 | First cue 93:3 at 8.48s | 93:1 at 0.08s, 93:2 at 3.20s, 93:3 at 8.48s |

78:1 still lacks sufficient matching ASR evidence in this recording. This change
does not replace the model or promise complete verse coverage. The twelve-second
startup gate measures analyzed audio, not guaranteed recognition completeness.

## First-word onset refinement

The renderer selects the latest CPU cue whose `t0` has passed; it does not wait
for the first word's end. However, greedy CTC letter emissions are often later
than the start of speech. There was also a larger delay when an opening word
was recognized in an earlier window but that window could not confirm the ayah:
the later accepted window could start the cue at the second or third word.

CPU look-ahead now uses the existing 20ms speech envelope to find a real pause
before the confirmed first word, bounded to a 1.5s search. It adds a 60ms lead
when that onset is found, or a conservative 120ms lead when connected/noisy
speech offers no reliable pause. It never rewinds before the source audio window
containing that word or across a preceding heard word. An onset correction that would cross
the previous ayah's last known word is rejected without discarding the new cue.
The transcript, passage identification and GPU timing remain unchanged.

For adjacent confirmed ayahs, the timing adapter also recovers an exact opening
word from the existing bounded observation history. This happens only AFTER
later words independently confirm the verse. The word must have been heard
within a bounded eight-second lookback from the confirming window and after the
preceding verse's last accepted word, and cannot be a token shared
with that preceding verse. No missing intermediate word or verse is invented.
Forced alignment still refines highlights only; it does not create verse cues.

`npm run test:local` includes onset/prefix recovery, pause/noise, shared-word
ambiguity, startup/seek resets and short-ayah ordering regressions.
`npm run test:ayah-onsets` replays four cached recitations through the built CPU
worker and compares the result with the same raw CTC evidence, without word
highlighting enabled. It requires the local evaluation corpus and scores against
Quran.com's published first-word references, which are approximate and may
include a portion of the preceding pause.

On the 34 scored transitions, mean absolute difference from those references
fell from about 324ms to 119ms; transitions over 300ms late fell from 10 to 3,
without adding/dropping verses or producing transitions over 300ms early.
Husary 93:5 moved from 28.05s (a later confirming word) to 24.18s, against a
published opening-word start of 24.24s. Accuracy remains best-effort, not a
universal guarantee. Live-only CPU mode still waits for recognition evidence;
without future audio it cannot reliably display an ayah before it is heard.

## Harness

`harness/shim.js` now supplies `chrome.runtime.id`, without which the content
script correctly treats its context as invalid and disposes itself. Legacy
whole-timeline mode remains supported.

For a CPU rendering-only fixture, run `node harness/serve.mjs` and open:

```text
http://localhost:5190/card?buffer=/harness/short-ayahs.json&media=gt_7_1.mp3
```

The media must exist in `server/cache/`; the fixture timings are synthetic and
intentionally do not match that recording. The page is labeled **UI only, no
recognition**. Do not inject the installed extension into the same harness page:
its content-script replacement events can dispose the shimmed copy. The browser
test uses separate clean browser instances for the harness and native controls.

GPU recognition/alignment and audio download/batching behavior are unchanged.
