import assert from 'node:assert/strict';
import { BatchedAudioSource, audioBatchPlan, MAX_VIDEO_SECONDS } from '../src/cpu/audio-batches.js';
import { YOUTUBE_LIMITS } from '../src/cpu/youtube-policy.js';
assert.equal(YOUTUBE_LIMITS.seconds, MAX_VIDEO_SECONDS);
assert.equal(YOUTUBE_LIMITS.batchSeconds, 1800);

for (const position of [0, 1, 3600, 35999, 36000]) {
  const { initial, rest } = audioBatchPlan(36000, position);
  assert.ok(initial.end - initial.start <= 180);
  assert.equal(initial.start, Math.max(0, Math.floor(position) - 10));
  assert.ok(rest.every((r) => r.end > r.start && r.end - r.start <= 1800));
  const sorted = [initial, ...rest].sort((a, b) => a.start - b.start);
  assert.equal(sorted[0].start, 0); assert.equal(sorted.at(-1).end, 36000);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i - 1].end, sorted[i].start, 'ten-hour plan has neither gaps nor overlaps');
}
assert.throws(() => audioBatchPlan(MAX_VIDEO_SECONDS + 1), /10 hours/);
assert.throws(() => audioBatchPlan(Infinity), /10 hours/);
assert.throws(() => audioBatchPlan(10, NaN), /10 hours/);
assert.deepEqual(audioBatchPlan(3).initial, { start: 0, end: 3, phase: 'initial' });

const tick = () => new Promise((r) => setImmediate(r));
const controller = new AbortController(), calls = [], reads = [], values = new Map(), opened = new Set();
let held = null, storeClosed = false;
const store = { has: (id) => values.has(id), async put(id, blob) { values.set(id, blob); },
  async get(id) { return values.get(id); }, async close() { values.clear(); storeClosed = true; } };
const source = new BatchedAudioSource({ duration: 36000, position: 3600, signal: controller.signal, store,
  async download(range) {
    calls.push({ start: range.start, end: range.end, phase: range.phase });
    if (range.phase === 'background') await new Promise((resolve, reject) => {
      held = { ...range, resolve };
      range.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    });
    range.signal.throwIfAborted();
    return { blob: new Blob(['audio']), start: range.start, end: range.end };
  },
  async open(_blob, metadata) {
    const input = { async read(start, end, signal) {
      signal.throwIfAborted(); reads.push([start, end]);
      // Distinct sample values expose boundary ordering/duplication errors.
      return new Float32Array(Math.round((end - start) * 16000)).fill(metadata.start);
    }, close() { opened.delete(input); } };
    opened.add(input); return input;
  },
});
await source.prepare(); await tick();
assert.deepEqual(calls[0], { start: 3590, end: 3770, phase: 'initial' });
assert.deepEqual(calls[1], { start: 3770, end: 5570, phase: 'background' });
assert.ok(held, 'background downloading starts without gating initial readiness');
const initial = await source.window(3600);
assert.equal(initial.start, 3600); assert.equal(initial.audio.length, 20 * 16000);
assert.ok(initial.audio.every((v) => v === 3590));
assert.deepEqual(reads, [[3600, 3620]], 'never decode the entire download batch');
const far = await source.window(25000);
assert.equal(far.start, 25000);
assert.ok(calls.some((c) => c.phase === 'seek' && c.start === 25000 && c.end === 25180), 'uncached seek preempts background with a three-minute request');
assert.ok(opened.size <= 2);
// A window straddles the initial boundary without a restart, duplicate or gap.
held.resolve(); await tick(); await tick();
const crossing = await source.window(3765);
assert.equal(crossing.audio.length, 20 * 16000);
assert.ok(crossing.audio.subarray(0, 5 * 16000).every((v) => v === 3590));
assert.ok(crossing.audio.subarray(5 * 16000).every((v) => v === 3770));
assert.ok(opened.size <= 2, 'keep at most two lazy demux/decoder inputs');
const abort = new AbortController();
const waiting = source.window(30000, { signal: abort.signal }); abort.abort();
await assert.rejects(waiting, { name: 'AbortError' });
const latest = await source.window(31000);
assert.equal(latest.start, 31000);
assert.equal(calls.some((c) => c.phase === 'seek' && c.start === 30000), false,
  'a superseded queued seek must never start downloading');
assert.ok(new Set(source.jobs).size === source.jobs.length, 'rapid seeks must not requeue one background job twice');
controller.abort(); await tick(); await tick();
assert.equal(source.closed, true); assert.equal(opened.size, 0); assert.equal(storeClosed, true);
await assert.rejects(source.window(0), { name: 'AbortError' });
const retryValues = new Map(), failures = [];
const retry = new BatchedAudioSource({ duration: 7200, position: 0, signal: new AbortController().signal,
  store: { has: (id) => retryValues.has(id), async put(id, blob) { retryValues.set(id, blob); },
    async get(id) { return retryValues.get(id); }, async close() { retryValues.clear(); } },
  async download(range) {
    if (range.phase === 'background') throw new Error('Temporary background failure');
    return { blob: new Blob(['retry']), start: range.start, end: range.end };
  },
  async open() { return { async read(start, end) { return new Float32Array(Math.round((end - start) * 16000)); }, close() {} }; },
  onProgress(p) { if (p.stage === 'failed') failures.push(p); },
});
await retry.prepare(); await tick();
assert.ok(failures.length > 0);
assert.equal((await retry.window(0)).audio.length, 20 * 16000, 'failed prefetch must not interrupt cached recognition audio');
assert.equal((await retry.window(5000)).start, 5000, 'a failed background range is retried as a small foreground fetch');
await retry.close();
assert.equal(retryValues.size, 0, 'close resolves only after cache cleanup');
console.log('Ten-hour batch coverage, three-minute startup/seek, background priority, 20s decoding, boundary stitching and Stop cleanup passed.');
