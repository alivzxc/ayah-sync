import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeFbank, normalizeAudio } from '../src/cpu/audio-features.js';

// Restore the old dense summation in an independent module to prove that the
// sparse loop leaves every input feature bit-for-bit identical.
const source = readFileSync(new URL('../src/cpu/audio-features.js', import.meta.url), 'utf8');
const sparse = 'for (let bin = MEL_START[bank]; bin < MEL_END[bank]; bin++)';
assert.ok(source.includes(sparse));
const denseSource = source.replace(sparse, 'for (let bin = 0; bin < power.length; bin++)');
const { computeFbank: dense } = await import(`data:text/javascript;base64,${Buffer.from(denseSource).toString('base64')}`);
let seed = 23;
const noise = Float32Array.from({ length: 64000 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000 - 0.5;
});
for (const audio of [new Float32Array(64000), noise,
  Float32Array.from({ length: 64000 }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000))]) {
  assert.deepEqual(computeFbank(audio), dense(audio));
  for (const peak of [0.005, 0.2, 1]) {
    assert.deepEqual(normalizeAudio(audio, peak), Float32Array.from(audio, (x) => x / peak));
  }
}
console.log('Sparse mel features are bit-for-bit identical to the previous dense computation.');
if (process.env.FEATURE_BENCH) {
  for (const fn of [computeFbank, dense]) for (let i = 0; i < 10; i++) fn(noise);
  const measure = (fn) => {
    const times = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now(); fn(noise); times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[20].toFixed(2);
  };
  console.log(`4s feature extraction median: dense ${measure(dense)}ms; sparse ${measure(computeFbank)}ms`);
}
