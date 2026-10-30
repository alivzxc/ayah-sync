import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher } from '../src/cpu/match.js';
import { PassageTracker } from '../src/cpu/passage-tracker.js';
import { RecognitionScheduler } from '../src/cpu/recognition-scheduler.js';
import { AudioWindow } from '../src/cpu/audio-window.js';
import { computeFbank } from '../src/cpu/audio-features.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani');
const matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
const tracker = new PassageTracker(matcher);
assert.equal(tracker.update(ar['2:255']), null, 'first global match remains tentative');
assert.equal(tracker.state().phase, 'confirming');
assert.equal(tracker.update(ar['2:255']).ref, '2:255');
assert.equal(tracker.state().nextRef, '2:256');
tracker.reset(true);
assert.equal(tracker.state().locked, true, 'pause/resume preserves passage');
assert.equal(tracker.update(ar['2:255']).ref, '2:255');
tracker.reset();
assert.equal(tracker.state().locked, false, 'seek discards passage');
assert.equal(tracker.update(ar['1:1']), null);
assert.equal(tracker.update(ar['1:1']), null, 'repeated basmala alone cannot identify the surah');
for (const partial of ['', 'حن الرحيم', 'الح', 'الحم']) tracker.update(partial);
assert.equal(tracker.update('unrelated speech'), null, 'one noisy window preserves tentative context');
assert.equal(tracker.update(ar['1:2']).ref, '1:2', 'two ambiguous phrases uniquely identify their sequence');
tracker.reset();
assert.equal(tracker.update(ar['1:1']), null);
assert.equal(tracker.update(`${ar['1:1']} ${ar['1:2']}`).ref, '1:2');
assert.equal(tracker.update(ar['1:3']).ref, '1:3', 'expected two-word ayah uses local context');
assert.equal(tracker.state().nextRef, '1:4');
assert.equal(tracker.update('unrelated speech'), null);
assert.equal(tracker.update('unrelated speech'), null);
assert.equal(tracker.state().locked, true, 'short partial windows preserve the passage');
for (let i = 0; i < 6; i++) tracker.update('unrelated longer speech');
assert.equal(tracker.state().locked, false, 'sustained lost confidence returns to global identification');
tracker.reset();
assert.equal(tracker.update(ar['2:255']), null);
assert.equal(tracker.update(ar['67:1']), null, 'unrelated candidates are not confirmation');
assert.equal(tracker.state().locked, false);

const switching = new PassageTracker(matcher);
switching.update(ar['67:1']); switching.update(ar['67:1']);
const nextWords = ar['67:2'].trim().split(/\s+/);
for (const partial of ['', 'يم', 'الذي', 'الذي القم']) switching.update(partial);
assert.equal(switching.state().ref, '67:1', 'boundary silence and partial words retain the anchor');
assert.equal(switching.update(`${ar['67:1']} ${nextWords[0]}`), null,
  'one token of the next ayah must not borrow confidence from the preceding ayah');
assert.equal(switching.state().ref, '67:1');
assert.equal(switching.update(`${ar['67:1']} ${nextWords.slice(0, 2).join(' ')}`).ref, '67:2',
  'a supported phrase confirms the next ayah');
assert.equal(switching.update(ar['67:1']), null, 'overlap must not switch back to the preceding ayah');
assert.equal(switching.state().ref, '67:2');

// Actual CTC boundary output from the Alafasy replay. Partial/no-text hops
// between these phrases previously erased the only disambiguating context.
const replay = new PassageTracker(matcher);
for (const text of ['بسم الله الرحمن الرحيم', 'بسم الله الرحمن الرحيم',
  'الرحمن الرحيم', 'الرحمن الرحيم', 'حن الرحيم', 'الح', 'الحم']) replay.update(text);
assert.equal(replay.update('الحمد لله رب العلمين')?.ref, '1:2');
for (const text of ['الحم ب العلمين', 'ال', '', 'الرحمن الرحيم']) replay.update(text);
assert.equal(replay.state().ref, '1:3', 'real partial transcripts must not strand the displayed ayah');
for (let i = 0; i < 11; i++) replay.update('unrelated longer speech', 0.5);
assert.equal(replay.state().locked, true, '250ms observations must not erase passage context twice as fast');
replay.update('unrelated longer speech', 0.5);
assert.equal(replay.state().locked, false, 'sustained contradictory evidence still releases context');

const evidence = matcher.match('إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْرٌ',
  matcher.match(ar['1:4']).pos, { localOnly: true, evidenceOnly: true,
    nearbyRefs: new Set(['1:4', '1:5', '1:6']) });
assert.notEqual(evidence?.ref, '1:6', 'hallucinated trailing words do not imply an unheard next ayah');

const sr = 1000;
const tone = Float32Array.from({ length: 64000 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / 16000));
const fbank = computeFbank(tone);
assert.equal(fbank.frames, 400, 'four seconds of 16 kHz audio produce 400 feature frames');
assert.equal(fbank.data.length, 400 * 80, 'each frame has 80 Kaldi mel bins');
assert.ok(fbank.data.every(Number.isFinite), 'feature values are finite');
assert.ok(fbank.data.some((value) => value > -10), 'non-silent input produces spectral energy');
const voiced = new Float32Array(100).fill(0.1);
const quiet = new Float32Array(100);
const pushSeconds = (scheduler, frame, seconds) => {
  for (let i = 0; i < seconds * 10; i++) scheduler.push(frame);
};
const scheduler = new RecognitionScheduler(sr);
pushSeconds(scheduler, voiced, 3);
assert.equal(scheduler.due(), null, 'wait for the first four-second window');
pushSeconds(scheduler, voiced, 1);
assert.equal(scheduler.due(), 'identify');
assert.equal(scheduler.windowSamples(), 4 * sr);
scheduler.submittedNow();
pushSeconds(scheduler, voiced, 1);
assert.equal(scheduler.due(), 'track', 'start the next chunk after one fresh second');
assert.equal(scheduler.windowSamples(), 4 * sr, 'keep a four-second chunk with three-second overlap');
const halfSecond = new RecognitionScheduler(sr);
pushSeconds(halfSecond, voiced, 4);
halfSecond.submittedNow();
pushSeconds(halfSecond, voiced, 0.5);
assert.equal(halfSecond.due(), 'track', 'refresh the rolling window after half a second');
halfSecond.submittedNow();
halfSecond.updateTracking({ locked: true, nearEnd: true }, 65, 4);
halfSecond.push(new Float32Array(250));
assert.equal(halfSecond.due(), 'track', 'fast multi-core inference refreshes every 250ms near a boundary');
halfSecond.updateTracking({ locked: true, nearEnd: true }, 150, 4);
assert.equal(halfSecond.due(), null, 'slow inference keeps the normal half-second cadence');
halfSecond.updateTracking({ locked: true, nearEnd: true }, 65, 1);
assert.equal(halfSecond.due(), null, 'single-thread fallback keeps its existing CPU budget');
halfSecond.updateTracking({ locked: true, nearEnd: false }, 65, 4);
assert.equal(halfSecond.due(), null, 'extra polling is restricted to ayah boundaries');

const steady = new RecognitionScheduler(sr);
let steadyCalls = 0;
for (let i = 0; i < 600; i++) {
  steady.push(voiced);
  if (steady.due()) { steadyCalls++; steady.submittedNow(); }
}
assert.equal(steadyCalls, 113, 'continuous speech gets a fixed four-second window twice per second');
const silent = new RecognitionScheduler(sr);
pushSeconds(silent, quiet, 4);
assert.equal(silent.due(), 'identify', 'silence does not control whether live chunks are submitted');
silent.submittedNow();
pushSeconds(silent, quiet, 0.5);
assert.equal(silent.due(), 'track', 'the fixed cadence is independent of voice activity');
silent.reset();
assert.equal(silent.due(), null, 'reset discards prior captured samples');

const audio = new AudioWindow(10);
audio.push(Float32Array.from([1, 2, 3, 4, 5]));
assert.deepEqual([...audio.snapshot(3)], [3, 4, 5]);
console.log('Passage matching, four-second windows, 500 ms stride and pause-independent live scheduling checks passed.');
