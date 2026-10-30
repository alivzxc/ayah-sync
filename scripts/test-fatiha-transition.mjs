import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher } from '../src/cpu/match.js';
import { PassageTracker } from '../src/cpu/passage-tracker.js';
import { passageTimings } from '../src/cpu/passage-timings.js';
import { LookaheadBuffer } from '../src/cpu/lookahead-buffer.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani');
const matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
function finishFatiha() {
  const tracker = new PassageTracker(matcher);
  tracker.update(ar['1:5']); tracker.update(ar['1:5']);
  assert.equal(tracker.update(ar['1:6'])?.ref, '1:6');
  assert.equal(tracker.update(ar['1:7'])?.ref, '1:7');
  assert.equal(tracker.state().nextRef, null, 'do not predict Al-Baqarah after Al-Fatiha');
  assert.equal(tracker.current.next, null);
  return tracker;
}

for (const ref of ['112:1', '113:1', '114:1', '67:1', '2:2', '2:255', '36:58']) {
  const tracker = finishFatiha();
  for (const text of ['', 'آمين', 'الله أكبر', 'الم']) {
    assert.equal(tracker.update(text), null, 'silence, prayer phrases and short text cannot pick a surah');
    assert.equal(tracker.current.ref, '1:7');
  }
  assert.equal(tracker.update(ar[ref]), null, 'the first new passage observation is tentative');
  assert.equal(tracker.current.ref, '1:7', 'retain Al-Fatiha until the new passage is confirmed');
  assert.equal(tracker.update(ar[ref])?.ref, ref, 'confirm any passage without waiting for local misses');
}

const basmala = finishFatiha();
for (let i = 0; i < 8; i++) {
  assert.equal(basmala.update(ar['1:1']), null, 'a repeated basmala cannot identify the next surah');
  assert.equal(basmala.current.ref, '1:7');
}
basmala.update(ar['112:1']);
assert.equal(basmala.update(ar['112:1'])?.ref, '112:1');
assert.equal(basmala.update(ar['112:2'])?.ref, '112:2', 'normal local tracking resumes after the jump');

const repeated = finishFatiha();
assert.equal(repeated.update(ar['1:1']), null);
assert.equal(repeated.current.ref, '1:7', 'basmala alone must not restart the passage');
assert.equal(repeated.update(ar['1:2'])?.ref, '1:2', 'basmala followed by al-hamd confirms a repeated Al-Fatiha');
assert.equal(repeated.newPassage, true, 'timed buffers must receive the confirmed passage boundary');
assert.equal(repeated.update(ar['1:3'])?.ref, '1:3');
assert.equal(repeated.newPassage, false, 'ordinary overlapping windows must not duplicate passage boundaries');

const noise = finishFatiha();
noise.update(ar['112:1']);
assert.equal(noise.update(ar['67:1']), null, 'unrelated observations do not confirm a jump');
assert.equal(noise.current.ref, '1:7');
assert.equal(noise.update(ar['1:7'])?.ref, '1:7', 'overlapping Fatiha audio stays on the last ayah');
assert.equal(noise.update(ar['112:1']), null, 'stale audio clears a tentative jump');
assert.equal(noise.update(ar['112:1'])?.ref, '112:1');

const stale = finishFatiha();
for (let i = 0; i < 2; i++) {
  assert.equal(stale.update(ar['1:6']), null, 'older Fatiha audio cannot move the tracker backwards');
  assert.equal(stale.current.ref, '1:7');
  assert.equal(stale.update(ar['55:13']), null, 'an ambiguous refrain cannot identify the next passage');
  assert.equal(stale.current.ref, '1:7');
}

const timed = finishFatiha(), buffer = new LookaheadBuffer();
function push(text, start) {
  const words = text.trim().split(/\s+/).map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.3 }));
  timed.update(text, 1, { start, words });
  buffer.add(start, 4, { timedWords: words, timingMatches: passageTimings(timed.timingMatches) }, 0);
}
push(ar['1:7'], 0);
push(ar['93:1'], 5); push(ar['93:2'], 7);
assert.deepEqual(buffer.cues.map((c) => c.match.ref), ['1:7'], 'short openings remain tentative');
push(ar['93:3'], 10); push(ar['93:3'], 10.5);
assert.deepEqual(buffer.cues.map((c) => c.match.ref), ['1:7', '93:1', '93:2', '93:3'],
  'confirmation recovers actual short opening timings without inventing Al-Baqarah cues');

assert.deepEqual([...matcher.nearbyRefs(matcher.match(ar['1:7']).pos)], ['1:6', '1:7']);
assert.equal(matcher.match(ar['1:6']).next.ref, '1:7', 'within-surah previews are unchanged');
assert.equal(matcher.match(ar['112:4']).next.ref, '113:1', 'other surah boundaries are unchanged');
console.log('Al-Fatiha prayer transitions, arbitrary passages, confirmation and anti-prediction checks passed.');
