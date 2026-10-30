import assert from 'node:assert/strict';
import { displayTiming } from '../src/cpu/display-timing.js';

const cue = { words: [
  { word: 0, start: 0, end: 1 }, { word: 1, start: 1, end: 2.3 }, { word: 2, start: 2, end: 4 },
], highlightWords: [{ word: 0, start: 0.1, end: 0.8 }, { word: 2, start: 2.1, end: 2.8 }] };
const timing = displayTiming(cue);
assert.deepEqual(timing.map((w) => w.word), [0, 1, 2], 'partial precise alignment must not remove a supported word');
assert.equal(timing[1].end, 2.1, 'raw fallback must stop at the next precise word');
assert.equal(timing.some((w) => w.start <= 0.9 && 0.9 < w.end), false, 'a precise silence gap must not fall back to that word\'s raw timing');
assert.equal(timing.some((w) => w.start <= 3 && 3 < w.end), false, 'do not stretch precise words to raw trailing ends');
assert.equal(displayTiming(cue), timing, 'animation frames must reuse merged timing');
cue.highlightWords = [...cue.highlightWords, { word: 1, start: 1.2, end: 1.8 }];
assert.equal(displayTiming(cue)[1].end, 1.8, 'new alignment must replace the raw fallback');
assert.deepEqual(displayTiming({ words: cue.words }).map((w) => w.word), [0, 1, 2]);
assert.deepEqual(displayTiming({ words: [], highlightWords: [] }), [], 'missing acoustic evidence cannot invent word highlights');
console.log('Per-word precise/raw timing fallback, silence gaps, bounded spans and rendering cache passed.');
