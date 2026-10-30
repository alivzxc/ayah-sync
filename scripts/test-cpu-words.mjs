import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decodeCtc, wordHighlight } from '../src/cpu/ctc-words.js';
import { displayWordIndex, displayWordIndices } from '../src/cpu/display-word.js';

const tokens = ['<blk>', 'ا', 'ب', 'ل', 'ه', '▁'];
function logits(path) {
  const data = new Float32Array(path.length * tokens.length).fill(-10);
  path.forEach((token, frame) => { data[frame * tokens.length + token] = 0; });
  return data;
}
const path = [1, 1, 0, 2, 5, 1, 3, 3, 4, 0];
const decoded = decodeCtc(logits(path), path.length, tokens, 1);
assert.equal(decoded.text, 'اب اله');
assert.equal(decoded.words.length, 2);
assert.equal(decoded.words[0].start, 0);
assert.equal(decoded.words[0].end, 0.4);
assert.equal(decoded.words[1].end, 0.9, 'trailing blanks must not extend a word through silence');
// Preserve the old greedy decoder's exact transcript for arbitrary CTC paths.
let seed = 17;
for (let n = 0; n < 100; n++) {
  const sequence = Array.from({ length: 99 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % tokens.length;
  });
  let old = '', previous = 0;
  for (const token of sequence) {
    if (token && token !== previous) old += tokens[token];
    previous = token;
  }
  old = old.replaceAll('▁', ' ').trim().replace(/\s+/g, ' ');
  assert.equal(decodeCtc(logits(sequence), 99, tokens, 4).text, old);
}
const match = { ref: '1:2', arabic: 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ', word: 3 };
const words = [
  { text: 'الحمد', start: 0.1, end: 0.4 },
  { text: 'لله', start: 0.5, end: 0.8 },
  { text: 'رب', start: 0.9, end: 1.1 },
];
assert.deepEqual(wordHighlight(words, match, 1.2), { ref: '1:2', word: 2, ageMs: (1.2 - 1.1) * 1000 });
assert.equal(wordHighlight([...words, { text: 'unknown', start: 1.1, end: 1.2 }], match, 1.2).word, -1);
assert.equal(wordHighlight([], match, 4).word, -1);
assert.equal(wordHighlight(words, null, 4), null);
assert.equal(displayWordIndex('الحمد لله رب العالمين', 'الحمد لله ۞ رب العالمين', 2), 3,
  'standalone display pause signs must not shift the highlighted word');
const uthmani = JSON.parse(readFileSync(new URL('../src/data/quran-uthmani.json', import.meta.url)));
const indopak = JSON.parse(readFileSync(new URL('../src/data/quran-indopak.json', import.meta.url)));
assert.deepEqual(displayWordIndices(uthmani['2:5'], indopak['2:5'], 0), [0], 'dotless hamza seats must map across scripts');
assert.deepEqual(displayWordIndices(uthmani['2:25'], indopak['2:25'], 3), [3, 4], 'one spoken word may span two IndoPak words');
assert.equal(displayWordIndex(uthmani['2:10'], indopak['2:10'], 9), displayWordIndex(uthmani['2:10'], indopak['2:10'], 10),
  'two spoken words may share one unspaced IndoPak display span');
assert.equal(displayWordIndices(uthmani['2:54'], indopak['2:54'], 15).length, 2, 'split dhal/lam spelling must highlight both display spans');

// Exercise the actual CPU painting function without starting a browser/model.
const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const paints = [], timers = new Map();
let now = 1000, id = 0;
const context = vm.createContext({ displayWordIndices, Date: { now: () => now }, Math,
  cpuHighlight: true, highlightTimer: null, shownWord: -1,
  liveMatch: match, builtText: match.arabic,
  paintWords(word) { paints.push(word); },
  setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
vm.runInContext(source.slice(source.indexOf('function paintCpuHighlight('), source.indexOf('function liveTick(')), context);
vm.runInContext(`paintCpuHighlight({ref:'1:2', word:2, expiresAt:1600})`, context);
assert.deepEqual(paints.at(-1), [2]);
assert.equal([...timers.values()][0].ms, 600);
now = 1600;
[...timers.values()][0].fn();
assert.equal(paints.at(-1), Infinity, 'stale evidence clears instead of predicting the next word');
vm.runInContext(`paintCpuHighlight({ref:'1:2', word:3, expiresAt:1500})`, context);
assert.equal(paints.at(-1), Infinity, 'late results must never flash an expired highlight');
vm.runInContext(`paintCpuHighlight({ref:'1:3', word:0, expiresAt:2000})`, context);
assert.equal(paints.at(-1), Infinity, 'another ayah cannot change the current word');
const wordEls = Array.from({ length: 3 }, () => ({ classList: { toggle() {} } }));
const painting = vm.createContext({ browserCPU: true, cpuHighlight: true, tl: null, wordEls });
const paintStart = source.indexOf('function paintWords(');
vm.runInContext(source.slice(paintStart, source.indexOf('\n//', paintStart)), painting);
vm.runInContext('paintWords(1)', painting);
assert.deepEqual(wordEls.map((w) => w._s), [1, 2, 1], 'CPU words before and after the highlight stay fully readable');
vm.runInContext('paintWords([0, 1])', painting);
assert.deepEqual(wordEls.map((w) => w._s), [2, 2, 1], 'all display fragments of one spoken word must light together');
vm.runInContext('browserCPU = false; paintWords(1)', painting);
assert.deepEqual(wordEls.map((w) => w._s), [1, 2, 0], 'GPU live styling remains unchanged');
vm.runInContext('browserCPU = true; tl = {}; paintWords(1)', painting);
assert.deepEqual(wordEls.map((w) => w._s), [1, 2, 0], 'aligned timeline styling remains unchanged');
console.log('Unchanged CTC transcripts, acoustic word evidence, script mapping and stale-highlight checks passed.');
