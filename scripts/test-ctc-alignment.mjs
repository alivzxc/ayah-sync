import assert from 'node:assert/strict';
import { alignCtcWords, speechEnvelope, stitchCtcWindows } from '../src/cpu/ctc-alignment.js';
import { LookaheadBuffer } from '../src/cpu/lookahead-buffer.js';

const tokens = ['<blk>', 'ا', 'ب', '▁'];
const path = [0, 1, 0, 0, 3, 0, 2, 0, 0, 0];
const probabilities = new Float32Array(path.length * tokens.length).fill(-12);
path.forEach((token, frame) => { probabilities[frame * tokens.length + token] = 0; });
const ayah = { ref: 'test:1', arabic: 'ا ب', wordCount: 2 };
const window = { words: [], logProbs: probabilities, frames: 10, duration: 1, range: [0, 1],
  envelope: { energy: Float32Array.from([0, 1, 1, 0, 0, 0, 1, 1, 0, 0]), step: 0.1, threshold: 0.5 } };
const aligned = alignCtcWords(window, ayah, tokens);
assert.deepEqual(aligned.map((w) => w.word), [0, 1]);
assert.equal(aligned[0].start, 0.1);
assert.ok(aligned[1].end <= 0.8, 'a real silence must stop a sustained-word highlight');
assert.ok(aligned.every((w) => w.confidence >= 0.2));
const silence = { ...window, logProbs: Float32Array.from(probabilities, (_, i) => i % tokens.length ? -12 : 0) };
assert.equal(alignCtcWords(silence, ayah, tokens).length, 0, 'canonical text must not manufacture words in blank-only scores');
assert.equal(alignCtcWords({ ...window, frames: 1, duration: 0.1 }, ayah, tokens).length, 0);
const envelope = speechEnvelope(new Float32Array(64000));
assert.equal(envelope.energy.length, 200);
assert.ok(envelope.energy.every((x) => x === 0));

const cached = [0, 1].map((start) => ({ start, duration: 4, frames: 10, logProbs: probabilities,
  envelope: speechEnvelope(new Float32Array(64000).fill(0.2)),
  words: [{ text: 'ا', start: 1.2, end: 1.5 }, { text: 'ب', start: 2, end: 2.5 }],
}));
const stitched = stitchCtcWindows(cached, { match: ayah, t0: 1.2, until: 4, complete: true }, tokens.length);
assert.ok(stitched.frames > cached[0].frames, 'cached CTC scores provide a longer acoustic context without another ASR call');
assert.equal(stitched.logProbs.length, stitched.frames * tokens.length);
assert.equal(stitchCtcWindows([], { match: ayah, t0: 0, until: 4 }, 4), null);

const buffer = new LookaheadBuffer();
buffer.add(0, 4, { timingMatch: ayah, timedWords: [
  { text: 'ا', start: 0.1, end: 0.5 }, { text: 'ب', start: 1, end: 1.5 },
] }, 0);
const before = JSON.stringify(buffer.cues.map(({ match, t0, words }) => ({ match, t0, words })));
for (const [start, shift, end] of [[0, 0, 0.5], [-0.1, 0.12, 0.62], [-0.2, 0.3, 3.8]]) {
  buffer.applyAlignments([{ ref: ayah.ref, start, duration: 4, spans: [
    { word: 0, start: 0.1 + shift, end, confidence: 0.9 },
    { word: 1, start: 1 - start, end: 1.5 - start, confidence: 0.9 },
  ] }]);
}
assert.ok(buffer.cues[0].highlightWords[0].end < 0.7, 'one bad window must not stretch a word across the next word');
assert.equal(JSON.stringify(buffer.cues.map(({ match, t0, words }) => ({ match, t0, words }))), before,
  'word alignment must not change recognition results or ayah boundaries');
console.log('Cached-score CPU CTC alignment, silence rejection, bounded envelopes and timing-consensus checks passed.');
