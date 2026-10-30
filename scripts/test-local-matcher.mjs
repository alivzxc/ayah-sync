import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranMatcher, normalizeArabic } from '../src/cpu/match.js';
import { AudioWindow } from '../src/cpu/audio-window.js';
import './test-local-tracking.mjs';
import './test-fatiha-transition.mjs';
import './test-cpu-live.mjs';
import './test-cpu-words.mjs';
import './test-audio-features.mjs';
import './test-live-routing.mjs';
import './test-lookahead-buffer.mjs';
import './test-startup-buffer.mjs';
import './test-ctc-alignment.mjs';
import './test-cpu-short-ayahs.mjs';
import './test-ayah-onset.mjs';
import './test-display-timing.mjs';
import './test-cpu-ambiguity.mjs';

const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url)));
const arabic = data('quran-uthmani');
const matcher = new QuranMatcher(arabic, data('quran-en'), data('surahs'), data('quran-indopak'));
assert.equal(normalizeArabic('ٱلْعَٰلَمِينَ'), normalizeArabic('العالمين'));
assert.equal(matcher.match(arabic['1:1']).ref, '1:1');
assert.equal(matcher.match(arabic['2:255']).ref, '2:255');
assert.equal(matcher.match(''), null);
assert.equal(matcher.match('مرحبا'), null);
const previous = matcher.match(arabic['1:2']);
assert.equal(matcher.match(arabic['1:3'], previous.pos).ref, '1:3', 'prefer current context over identical opening words');
const window = new AudioWindow(4);
window.push(new Float32Array([1, 2, 3]));
assert.deepEqual([...window.snapshot()], [1, 2, 3]);
window.push(new Float32Array([4, 5, 6]));
assert.deepEqual([...window.snapshot()], [3, 4, 5, 6]);
assert.deepEqual([...window.snapshot(3, 2)], [3, 4], 'pause snapshots stop before trailing silence');
assert.deepEqual([...window.snapshot(3, 100)], [], 'trimming never reads overwritten samples');
assert.equal(window.total, 6);
window.reset();
assert.deepEqual([...window.snapshot()], []);

for (const ref of ['1:2', '1:7', '2:255', '67:1', '112:1']) {
  const match = matcher.match(arabic[ref]);
  assert.equal(match.ref, ref);
  assert.equal(match.score, 1);
}
console.log('Arabic normalization, verse matching and audio buffer checks passed.');
