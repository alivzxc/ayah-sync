import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher } from '../src/cpu/match.js';
import { PassageTracker } from '../src/cpu/passage-tracker.js';
import { passageTimings } from '../src/cpu/passage-timings.js';
import { LookaheadBuffer } from '../src/cpu/lookahead-buffer.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani');
const matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
function pipeline() {
  const tracker = new PassageTracker(matcher), buffer = new LookaheadBuffer();
  return { tracker, buffer, push(text, start, times) {
    const words = text.trim().split(/\s+/).filter(Boolean).map((text, i) => ({ text,
      start: times?.[i]?.[0] ?? i * 0.45 + 0.1, end: times?.[i]?.[1] ?? i * 0.45 + 0.4 }));
    tracker.update(text, 1, { start, words });
    buffer.add(start, 4, { timedWords: words, timingMatches: passageTimings(tracker.timingMatches) }, 0);
  } };
}
const refs = (p) => p.buffer.cues.map((c) => c.match.ref);
const mixed = pipeline();
mixed.push(ar['112:1'], 0); mixed.push(ar['112:1'], 0);
mixed.push(`${ar['112:2']} ${ar['112:3'].split(/\s+/).slice(0, 2).join(' ')}`, 2);
assert.equal(mixed.tracker.current.ref, '112:3');
assert.deepEqual(refs(mixed), ['112:1', '112:2', '112:3'], 'one accepted window must retain every supported ayah');
mixed.push(ar['112:1'], 3);
assert.deepEqual(refs(mixed), ['112:1', '112:2', '112:3'], 'overlapping stale audio cannot move cues backwards');

const single = pipeline();
single.push(ar['55:62'], 0); single.push(ar['55:62'], 0); single.push(ar['55:63'], 3);
single.push('مدهامت', 6);
assert.equal(single.tracker.current.ref, '55:63', 'unfinished singleton does not advance');
single.push(ar['55:64'], 7);
assert.equal(single.tracker.current.ref, '55:64', 'complete one-word next ayah uses the confirmed passage');
assert.equal(refs(single).at(-1), '55:64');
single.push(ar['55:64'], 8);
assert.equal(refs(single).filter((r) => r === '55:64').length, 1, 'repeat windows do not duplicate cues');
single.tracker.reset();
assert.equal(single.tracker.update(ar['55:64']), null, 'a singleton cannot identify a passage globally');
assert.equal(single.tracker.timingMatches.length, 0);
assert.equal(matcher.shortMatch(ar['55:13'], new Set(['55:13', '55:16'])), null,
  'identical refrains cannot resolve their own position during startup recovery');

const startup = pipeline();
startup.push(ar['93:1'], 0);
startup.push(ar['93:2'], 3);
assert.deepEqual(refs(startup), [], 'short tentative windows are not displayed before confirmation');
startup.push(ar['93:3'], 8); startup.push(ar['93:3'], 8);
assert.deepEqual(refs(startup), ['93:1', '93:2', '93:3'], 'confirmed context recovers acoustically supported startup ayahs');
startup.tracker.reset(); startup.buffer.reset();
startup.push(ar['112:1'], 0); startup.push(ar['112:1'], 0);
assert.deepEqual(refs(startup), ['112:1'], 'seek cannot recover evidence from the preceding passage');

const timing = pipeline();
timing.push(ar['78:3'], 6, [[0.08, 0.57], [0.73, 0.89], [1.09, 1.45], [1.66, 4]]);
timing.push(ar['78:3'], 7, [[0.1, 0.5], [0.6, 0.8], [0.9, 1.2], [1.3, 4]]);
assert.equal(timing.buffer.cues[0].lastEnd, 11);
timing.push(ar['78:4'], 8, [[2.02, 2.59], [2.75, 4]]);
assert.deepEqual(refs(timing), ['78:3', '78:4'], 'stretched previous word ends cannot exclude valid next-word onsets');
assert.equal(timing.buffer.cues[1].t0, 10.02);
timing.push(ar['78:5'], 11, [[1.2, 1.5], [1.6, 1.9], [2, 4]]);
assert.deepEqual(refs(timing), ['78:3', '78:4', '78:5']);
assert.equal(timing.buffer.cues[2].t0, 12.2, 'repeated phrase must use the fifth ayah occurrence, not the fourth');
assert.ok(timing.buffer.cues[0].words.every((w) => w.end <= 10.02));

const gap = pipeline();
gap.push(ar['112:1'], 0); gap.push(ar['112:1'], 0); gap.push(ar['112:3'], 3);
assert.deepEqual(refs(gap), ['112:1', '112:3'], 'passage continuity alone cannot invent an unheard intervening ayah');
const unchanged = refs(gap);
gap.buffer.add(4, 4, { timingMatch: gap.tracker.current, timingMatches: [], timedWords: [] }, 0);
assert.deepEqual(refs(gap), unchanged, 'empty authoritative evidence must not fall back to stale per-verse alignment');

const silence = pipeline();
silence.push(ar['112:1'], 0); silence.push(ar['112:1'], 0);
for (let start = 1; start <= 20; start++) silence.push('', start);
assert.deepEqual(refs(silence), ['112:1'], 'analyzed silence never fills missing verses by prediction');
assert.ok(silence.tracker.history.length <= 12, 'startup observations stay bounded');
assert.ok(silence.buffer.history.length <= 9, 'raw word history stays bounded');
console.log('CPU multi-ayah windows, singleton context, startup recovery, stale ends, refrains and anti-hallucination regressions passed.');
