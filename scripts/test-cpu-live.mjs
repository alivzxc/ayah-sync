import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AudioWindow } from '../src/cpu/audio-window.js';
import { RecognitionScheduler } from '../src/cpu/recognition-scheduler.js';
import { recognitionCooldown } from '../src/cpu/live-pacing.js';

assert.equal(recognitionCooldown(100), 250);
assert.equal(recognitionCooldown(6000), 3000);
assert.equal(recognitionCooldown(30000), 5000);
assert.equal(recognitionCooldown(65, true), 100);
assert.equal(recognitionCooldown(6000, true), 3000, 'responsive mode cannot bypass slow-CPU backpressure');
let now = 0;
let tick;
let pausedClock = false;
let holdClock = false;
let resolveClock;
let receiveMessage;
const submitted = [];
const messages = [];
const timers = new Map();
let timerId = 0;
const context = vm.createContext({ AudioWindow, RecognitionScheduler, recognitionCooldown,
  Float32Array, performance: { now: () => now }, console,
  Worker: class { postMessage(m) { submitted.push(m); } terminate() {} },
  WebSocket: class { static OPEN = 1; constructor() { throw new Error('CPU live must not open a helper socket'); } },
  setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  chrome: { runtime: { getURL: () => 'chrome-extension://test/', onMessage: { addListener(fn) { receiveMessage = fn; } },
    async sendMessage(m) {
      messages.push(m);
      if (m.type === 'CAPTURE_CLOCK') {
        if (holdClock) return new Promise((resolve) => { resolveClock = resolve; });
        return { key: 'video', duration: 1200, time: 8, paused: pausedClock, captureEpoch: 1 };
      }
    } } },
});
const code = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8')
  .replaceAll('import.meta.env.DEV', 'false')
  .replace(/^import .*;\n/gm, '').replace(/new URL\([^\n]*import\.meta\.url\)/g, "'worker.js'");
vm.runInContext(code, context);
vm.runInContext(`
  running = true; backend = 'browser'; connectBrowser();
  recognitionWorker.onmessage({ data: { type: 'ready', threads: 1 } });
  const frame = new Float32Array(6 * 16000).fill(0.1);
  windowAudio.push(frame); scheduler.push(frame);
`, context);
tick();
await new Promise((r) => setImmediate(r));
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1);
assert.equal(submitted.find((m) => m.type === 'audio').audio.length, 4 * 16000,
  'the first live inference uses a four-second window');
tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1, 'busy inference never queues another call');
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation,
  ms: 6000, match: { ref: '1:2' }, tracking: { locked: true } } });
  scheduler.push(new Float32Array(8 * 16000).fill(0.1));`, context);
assert.ok(messages.some((m) => m.type === 'RESULT' && m.match.ref === '1:2'));
now = 2999; tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, 1, 'slow inference retains its adaptive cooldown');
now = 3001; tick();
await new Promise((r) => setImmediate(r));
assert.equal(submitted.filter((m) => m.type === 'audio').length, 2);
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation, ms: 1000 } });
  scheduler.push(new Float32Array(8 * 16000).fill(0.1));`, context);
pausedClock = true;
now = 10000; tick();
await new Promise((r) => setImmediate(r));
assert.equal(submitted.filter((m) => m.type === 'audio').length, 3,
  'captured audio continues on the fixed cadence regardless of media pause state');
assert.ok(submitted.every((m) => ['init', 'audio', 'reset'].includes(m.type)), 'no scan jobs exist');
assert.ok(!messages.some((m) => /SCAN|DOWNLOAD|ALIGN/.test(m.type)), 'no timeline jobs or helper requests');
vm.runInContext('stopCapture()', context);
const fallbackStart = submitted.length;
const fallbackMessages = messages.length;
vm.runInContext(`
  running = true; connectBrowser();
  recognitionWorker.onmessage({ data: { type: 'error', initializing: true, error: 'Thread pool unavailable' } });
`, context);
assert.deepEqual(submitted.slice(fallbackStart).map((m) => m.maxThreads), [4, 1],
  'failed threaded initialization retries once in a fresh single-thread worker');
assert.ok(!messages.slice(fallbackMessages).some((m) => m.type === 'STATUS' && m.status === 'stopped'),
  'thread fallback must keep the captured audio stream alive');
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'ready', threads: 1 } });`, context);
assert.ok(messages.some((m) => m.type === 'DEBUG' && /1 thread\(s\)/.test(m.text)));
vm.runInContext('stopCapture()', context);
holdClock = true;
const beforeBlockedClock = submitted.filter((m) => m.type === 'audio').length;
vm.runInContext(`
  running = true; captureEpoch = 7; resetRecognition(); connectBrowser();
  recognitionWorker.onmessage({ data: { type: 'ready', threads: 4 } });
  const delayedFrame = new Float32Array(4 * 16000).fill(0.1);
  windowAudio.push(delayedFrame); scheduler.push(delayedFrame);
`, context);
tick();
assert.equal(submitted.filter((m) => m.type === 'audio').length, beforeBlockedClock + 1,
  'inference must start immediately even while the page clock promise is unresolved');
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation, ms: 65,
  match: { ref: '1:3' }, tracking: { locked: true, nearEnd: true } } });`, context);
assert.equal(messages.filter((m) => m.type === 'RESULT').at(-1).captureEpoch, 7,
  'results carry their submission epoch without waiting for the page clock');
const oldGeneration = vm.runInContext('generation', context);
receiveMessage({ target: 'offscreen', type: 'RESET_CAPTURE', captureEpoch: 8 }, {}, () => {});
const resultCount = messages.filter((m) => m.type === 'RESULT').length;
vm.runInContext(`recognitionWorker.onmessage({ data: { type: 'result', generation: ${oldGeneration},
  ms: 65, match: { ref: '1:3' } } });`, context);
assert.equal(messages.filter((m) => m.type === 'RESULT').length, resultCount,
  'a pre-seek result is discarded even if the clock is still blocked');
resolveClock({ key: 'old-video', duration: 1200 });
await new Promise((r) => setImmediate(r));
assert.equal(vm.runInContext('captureEpoch', context), 8);
vm.runInContext('stopCapture()', context);
console.log('CPU live-only capture, no helper, bounded inference, adaptive cooldown and pause checks passed.');
