import assert from 'node:assert/strict';
import { LookaheadBuffer, alignTimedWords } from '../src/cpu/lookahead-buffer.js';

const a = { ref: '1:2', arabic: 'الحمد لله رب العالمين', wordCount: 4 };
const b = { ref: '1:3', arabic: 'الرحمن الرحيم', wordCount: 2 };
const words = [{ text: 'الحمد', start: 0.1, end: 0.5 }, { text: 'لله', start: 0.6, end: 0.9 },
  { text: 'رب', start: 1, end: 1.2 }, { text: 'العالمين', start: 1.3, end: 2 }];
assert.deepEqual(alignTimedWords(words, a).map((w) => w.word), [0, 1, 2, 3]);
const buffer = new LookaheadBuffer();
buffer.add(5, 4, { timedWords: words }, 6);
assert.equal(buffer.cues.length, 0, 'timed words alone cannot invent an unconfirmed verse');
buffer.add(6, 4, { timedWords: [], timingMatch: a }, 6);
assert.equal(buffer.cues[0].t0, 5.1, 'confirmed verses can reuse acoustic evidence from preceding windows');
buffer.add(10, 4, { timingMatch: b, timedWords: [
  { text: 'الرحمن', start: 0.5, end: 0.9 }, { text: 'الرحيم', start: 1, end: 1.4 },
] }, 6);
assert.equal(buffer.cues[1].t0, 10.5);
assert.equal(buffer.cues.findLast((c) => c.t0 <= 9).match.ref, '1:2', 'future recognition must not switch the current playhead early');
assert.equal(buffer.cues.findLast((c) => c.t0 <= 10.5).match.ref, '1:3');
for (let i = 0; i < 100; i++) buffer.add(11 + i, 4, { timedWords: [], timingMatch: b }, 11 + i);
assert.ok(buffer.history.length <= 9, 'retained raw transcript windows are bounded');
buffer.reset();
assert.equal(buffer.cues.length, 0);
assert.equal(buffer.from, null);
buffer.add(0, 8, { timedWords: [] }, 0);
buffer.add(1, 4, { timedWords: [] }, 0);
assert.equal(buffer.until, 8, 'adaptive recognition windows must never shrink processed coverage');

const repeated = new LookaheadBuffer({ retainCues: true });
const end = { ref: '1:7', pos: 20, arabic: 'صراط الذين', wordCount: 2 };
const restart = { ref: '1:1', pos: 0, arabic: 'بسم الله', wordCount: 2 };
const observed = (match, start, newPassage = false) => ({ newPassage, timingMatches: [{ match,
  spans: [{ word: 0, start, end: start + 0.5 }, { word: 1, start: start + 0.6, end: start + 1 }] }] });
repeated.add(0, 4, observed(end, 0), 0);
repeated.add(1, 4, observed(restart, 2), 0);
assert.equal(repeated.cues.length, 1, 'stale earlier ayahs must still be rejected without passage confirmation');
repeated.add(3, 4, observed(restart, 4, true), 0);
assert.deepEqual(repeated.cues.map((c) => c.match.ref), ['1:7', '1:1'], 'a confirmed new passage may restart at an earlier ayah');
repeated.add(4, 4, observed(restart, 4), 0);
assert.equal(repeated.cues.length, 2, 'subsequent overlapping windows must extend the new cue, not duplicate it');
repeated.add(5, 4, observed(restart, 5, true), 0);
assert.equal(repeated.cues.length, 2, 'reconfirming the same ayah after a worker reset must not split its cue');
assert.equal(repeated.cues[0].lastEnd <= repeated.cues[1].t0, true);
console.log('CPU look-ahead acoustic timing, no-early-switch, seek reset and bounded-history checks passed.');
