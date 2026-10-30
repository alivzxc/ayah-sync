import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firstWordOnset } from '../src/cpu/ayah-onset.js';
import { QuranMatcher } from '../src/cpu/match.js';
import { PassageTracker } from '../src/cpu/passage-tracker.js';
import { passageTimings } from '../src/cpu/passage-timings.js';
import { LookaheadBuffer } from '../src/cpu/lookahead-buffer.js';

const envelope = (from, until = 3) => ({ step: 0.02, threshold: 0.1,
  energy: Float32Array.from({ length: 150 }, (_, i) => i * 0.02 >= from && i * 0.02 < until ? 1 : 0) });
assert.ok(Math.abs(firstWordOnset(envelope(1), 1.5) - 0.94) < 1e-6, 'confirmed speech after a real pause gives an onset plus 60ms lead');
assert.ok(firstWordOnset(envelope(1), 1.5, 1.25) >= 1.25, 'do not rewind into the previous heard word');
assert.ok(Math.abs(firstWordOnset(envelope(0), 1.5) - 1.38) < 1e-6, 'continuous speech gets only a bounded 120ms lead');
assert.equal(firstWordOnset(envelope(0), 0.05), 0, 'never create negative timestamps at startup');
assert.ok(firstWordOnset(envelope(0.1), 2.5) >= 1, 'onset search stays bounded to 1.5 seconds');
assert.ok(Math.abs(firstWordOnset(envelope(1, 1.4), 1.48) - 0.94) < 1e-6, 'a delayed token can land just after speech ended');
const noisy = envelope(0);
noisy.energy[50] = noisy.energy[51] = 0;
assert.ok(firstWordOnset(noisy, 1.5) >= 1.38 - 1e-6, 'short consonant closures are not ayah boundary pauses');

const ordered = new LookaheadBuffer();
const a = { ref: 'test:1', pos: 1, arabic: 'قبل شيء', wordCount: 2 };
const b = { ref: 'test:2', pos: 3, arabic: 'بعد شيء', wordCount: 2 };
ordered.add(0, 4, { timingMatches: [{ match: a, spans: [
  { word: 0, start: 1, end: 1.8 }, { word: 1, start: 2, end: 2.5 },
] }] }, 0);
ordered.add(1, 4, { timingMatches: [{ match: b, spans: [
  { word: 0, start: 1.95, rawStart: 2.3, end: 2.5 }, { word: 1, start: 2.6, end: 3 },
] }] }, 0);
assert.deepEqual(ordered.cues.map((c) => c.match.ref), ['test:1', 'test:2'], 'earlier onset cannot reintroduce skipped two-word ayahs');
assert.equal(ordered.cues[1].t0, 2.3, 'unsafe rewind is rejected instead of stealing the preceding word');

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani'), matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
function pipeline() {
  const tracker = new PassageTracker(matcher), buffer = new LookaheadBuffer();
  return { tracker, buffer, push(text, start) {
    const words = text.trim().split(/\s+/).map((text, i) => ({ text, start: 0.1 + i * 0.3, end: 0.35 + i * 0.3 }));
    tracker.update(text, 1, { start, words });
    buffer.add(start, 4, { timingMatches: passageTimings(tracker.timingMatches) }, 0);
  } };
}
const delayed = pipeline();
delayed.push(ar['93:4'], 12); delayed.push(ar['93:4'], 12);
delayed.push(ar['93:5'].split(/\s+/)[0], 23);
assert.equal(delayed.tracker.current.ref, '93:4', 'a lone opening word still cannot advance recognition');
assert.deepEqual(delayed.buffer.cues.map((c) => c.match.ref), ['93:4']);
delayed.push(ar['93:5'].split(/\s+/).slice(2).join(' '), 27);
assert.equal(delayed.tracker.current.ref, '93:5');
assert.equal(delayed.buffer.cues.at(-1).t0, 23.1, 'later confirmation recovers the exact first word, not the third-word onset');
assert.deepEqual(delayed.buffer.cues.at(-1).words.map((w) => w.word), [0, 2, 3], 'missing intermediate words are not fabricated');

const refrain = pipeline();
refrain.push(ar['67:1'], 0); refrain.push(ar['67:1'], 0);
refrain.push(ar['67:2'].split(/\s+/)[0], 4);
refrain.push(ar['67:2'].split(/\s+/).slice(1, 3).join(' '), 6);
assert.equal(refrain.tracker.current.ref, '67:2');
assert.ok(!refrain.buffer.cues.at(-1).words.some((w) => w.word === 0), 'a shared first word cannot disambiguate its own audio occurrence');

const stale = pipeline();
stale.push(ar['93:5'].split(/\s+/)[0], 0);
stale.push(ar['93:4'], 1); stale.push(ar['93:4'], 1);
stale.push(ar['93:5'].split(/\s+/).slice(2).join(' '), 10);
assert.ok(!stale.buffer.cues.at(-1).words.some((w) => w.word === 0), 'do not reuse a first word heard before the preceding accepted verse');
const old = pipeline();
old.push(ar['93:4'], 12); old.push(ar['93:4'], 12);
old.push(ar['93:5'].split(/\s+/)[0], 23);
old.push(ar['93:5'].split(/\s+/).slice(2).join(' '), 80);
assert.ok(!old.buffer.cues.at(-1).words.some((w) => w.word === 0), 'a long silent gap cannot reuse stale prefix audio indefinitely');
delayed.tracker.reset();
assert.equal(delayed.tracker.lastWordStart, null);
assert.equal(delayed.tracker.history.length, 0, 'seek resets onset evidence');
console.log('CPU acoustic first-word onset, bounded lead, delayed-prefix recovery, short-ayah ordering and anti-prediction checks passed.');
