import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher, normalizeArabic } from '../src/cpu/match.js';
import { PassageTracker } from '../src/cpu/passage-tracker.js';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const ar = data('quran-uthmani');
const matcher = new QuranMatcher(ar, data('quran-en'), data('surahs'));
const shared = 'وإذ قال إبراهيم رب اجعل هذا';

assert.equal(normalizeArabic('إِبْرَٰهِۦمُ'), normalizeArabic('إبراهيم'), 'internal small yeh must not bias the same phrase toward another surah');
assert.equal(normalizeArabic('بِهِۦ'), normalizeArabic('به'), 'pronoun-ending small yeh must remain a recitation mark');
const unresolved = matcher.match(shared, null, { evidenceOnly: true });
assert.equal(unresolved.ambiguous, true);
assert.deepEqual(new Set(unresolved.alternatives.map((m) => m.ref)), new Set(['2:126', '14:35']));
for (const [currentRef, nextRef, expected] of [
  ['2:125', '2:126', '2:126'], ['14:34', '14:35', '14:35'], ['14:10', '14:11', '14:35'],
]) {
  const result = matcher.match(shared, null, { evidenceOnly: true, currentRef, nextRef });
  assert.equal(result.ref, expected, 'expected next ayah/current surah must win an equal-evidence phrase tie');
  assert.equal(result.ambiguous, false);
}
assert.equal(matcher.match(ar['2:255'], null, { evidenceOnly: true, currentRef: '14:34', nextRef: '14:35' }).ref, '2:255',
  'passage preference must not override stronger evidence for a different ayah');
assert.equal(matcher.match(ar['55:13'], matcher.refStarts.get('55:16') + 2, {
  localOnly: true, nearbyRefs: new Set(['55:13', '55:16']), evidenceOnly: true, allowEarlierEvidence: true,
}).ambiguous, true, 'current-ayah priority must not reassign an earlier repeated refrain during timing recovery');

const tracker = new PassageTracker(matcher);
tracker.update(ar['14:34']); tracker.update(ar['14:34']);
assert.equal(tracker.current.ref, '14:34');
for (let i = 0; i < 6; i++) tracker.update('كلمات ليست من القرآن');
assert.equal(tracker.locked, false);
assert.equal(tracker.context.ref, '14:34', 'temporary recognition misses must retain the surah hint');
tracker.update(shared);
assert.equal(tracker.update(shared)?.ref, '14:35');
tracker.reset();
assert.equal(tracker.context, null, 'a user seek must clear old surah and next-ayah precedence');
assert.equal(tracker.update(shared), null);
assert.equal(tracker.update(shared), null, 'a shared phrase alone must remain tentative after a seek');
assert.deepEqual(new Set(tracker.state().ambiguousRefs), new Set(['2:126', '14:35']));
const weakAlternative = new PassageTracker(matcher);
weakAlternative.pending = { ambiguous: true, alternatives: [
  { ref: '2:126', score: 1, evidenceWords: 6, refEvidenceWords: 6, refWordCount: 32 },
  { ref: '14:35', score: 1, evidenceWords: 6, refEvidenceWords: 1, refWordCount: 13 },
] };
assert.deepEqual(weakAlternative.state().ambiguousRefs, ['2:126'], 'a weak endpoint is not a second definite ayah match');

tracker.reset();
for (let start = 0; start < 22; start++) {
  tracker.update(shared, 1, { start, words: shared.split(/\s+/).map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.15 })) });
}
assert.equal(tracker.history.length, 22, 'extended ambiguity checks must retain the initial phrase for later recovery');
assert.equal(tracker.update(ar['2:126'], 1, { start: 23,
  words: ar['2:126'].split(/\s+/).map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.15 })) })?.ref, '2:126');
assert.ok(tracker.timingMatches.some((m) => m.observation?.start === 0), 'later context must recover the supported first phrase, not lose its beginning');
tracker.update(ar['2:127']);
assert.ok(tracker.history.length <= 12, 'normal tracking must restore the smaller token history');

const refrain = new PassageTracker(matcher);
refrain.update(ar['78:3']); refrain.update(ar['78:3']);
assert.equal(refrain.update(ar['78:4'])?.ref, '78:4');
assert.equal(refrain.update(ar['78:4'])?.ref, '78:4', 'next-ayah precedence must not advance on stale overlapping refrains');
console.log('Shared-phrase precedence, orthographic equivalence, seek hint reset and stale-refrain protection passed.');
