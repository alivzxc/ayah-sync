// Production scheduler with a virtual media clock/worker. No model or network:
// exercise minutes of playback, cached replay and slow inference deterministically.
import assert from 'node:assert/strict';
import { startLookahead } from '../src/cpu/lookahead.js';

async function session(test) {
  const originals = Object.fromEntries(['chrome', 'Worker', 'WebSocket', 'setTimeout', 'clearTimeout', 'performance']
    .map((key) => [key, globalThis[key]]));
  let now = 0, serial = 0, playhead = 0, paused = true, inferenceMs = 100, clockDelay = 0;
  let rate = 1;
  let nearEnd = false;
  let ambiguousRefs = [], multiAyahs = false;
  const timers = new Map(), messages = [], requests = [];
  const duration = 600;
  const later = (fn, delay = 0) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  globalThis.setTimeout = later;
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.performance = { now: () => now };
  globalThis.chrome = { runtime: { getURL: (path) => path, sendMessage: async () => {
    const clock = { key: 'test', time: playhead, duration, paused, seeking: false, playbackRate: rate };
    return clockDelay ? new Promise((yes) => later(() => yes(clock), clockDelay)) : clock;
  } } };
  globalThis.Worker = class {
    postMessage(data) {
      if (data.type === 'reset') return;
      const delay = data.type === 'audio' ? inferenceMs : 0;
      if (data.type === 'audio') requests.push({ start: data.audioStart, at: now, seconds: data.audio.length / 16000 });
      later(() => this.onmessage?.({ data: data.type === 'init' ? { type: 'ready', threads: 1 }
        : data.type === 'align' ? { type: 'alignment', alignedWindows: [] }
        : { type: 'result', ms: inferenceMs, tracking: { locked: new Set(ambiguousRefs).size < 2, nearEnd, ambiguousRefs }, timingMatches: [{
          match: { ref: '2:1', pos: 1, arabic: 'الحمد لله', wordCount: 2 },
          spans: [{ word: 0, start: data.audioStart, end: data.audioStart + 1 },
            { word: 1, start: data.audioStart + 1, end: data.audioStart + 2 }],
        }, ...(multiAyahs ? [{ match: { ref: '2:2', pos: 3, arabic: 'الرحمن الرحيم', wordCount: 2 },
          spans: [{ word: 0, start: data.audioStart + 2, end: data.audioStart + 2.5 },
            { word: 1, start: data.audioStart + 2.6, end: data.audioStart + 3 }] }] : [])] } }), delay);
    }
    terminate() {}
  };
  globalThis.WebSocket = class {
    constructor() { later(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }); }); }
    send(raw) {
      const data = JSON.parse(raw);
      later(() => this.onmessage?.({ data: JSON.stringify(data.type === 'cpu_audio_prepare'
        ? { type: 'cpu_audio_ready', duration, sampleRate: 16000 }
        : { type: 'cpu_audio_window', id: data.id, start: data.start, sampleRate: 16000,
          pcm: Buffer.alloc(20 * 16000 * 4).toString('base64') }) }));
    }
    close() {}
  };
  const api = startLookahead({ key: 'test', captureEpoch: 1 }, (message) => messages.push(structuredClone(message)));
  const advance = async (seconds) => {
    const end = now + seconds * 1000;
    await flush();
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      if (!paused) playhead += (next[1].at - now) / 1000 * rate;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    if (!paused) playhead += (end - now) / 1000 * rate;
    now = end; await flush();
  };
  try {
    await test({ api, advance, messages, requests, latest: () => messages.findLast((m) => m.type === 'BUFFER'),
      play: () => { paused = false; }, pause: () => { paused = true; },
      seek: (time) => { playhead = time; api.reset(2, time); },
      jump: (time) => { playhead = time; }, slow: (ms) => { inferenceMs = ms; },
      lagClock: (ms) => { clockDelay = ms; }, setRate: (value) => { rate = value; },
      boundary: (value) => { nearEnd = value; }, ambiguity: (refs) => { ambiguousRefs = refs; },
      multipleAyahs: (value) => { multiAyahs = value; } });
    assert.equal(messages.some((m) => m.type === 'ERROR'), false);
  } finally {
    await api.stop();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

await session(async ({ advance, latest, play, pause, seek, requests }) => {
  await advance(10);
  assert.equal(latest().ready, true);
  play(); await advance(180); pause(); await advance(2);
  assert.ok(latest().until > 180);
  seek(0); await advance(1);
  const count = requests.length;
  play(); await advance(60);
  assert.ok(latest().cueUntil >= 61, 'cached replay must refresh the visible cue slice as playback advances');
  assert.equal(requests.length, count, 'replaying cached audio must not repeat inference');
});
await session(async ({ advance, latest, play, pause, slow, messages }) => {
  await advance(10);
  const initialResets = messages.filter((m) => m.type === 'BUFFER' && !m.ready).length;
  slow(4500); play(); await advance(30); pause(); await advance(15);
  assert.equal(messages.filter((m) => m.type === 'BUFFER' && !m.ready).length, initialResets,
    'normal playback during slow CPU work must not reset a ready segment');
  assert.equal(latest().from, 0);
});
await session(async ({ advance, latest, play, slow, messages }) => {
  await advance(10);
  slow(500); play(); await advance(300);
  const steady = messages.filter((m) => m.type === 'BUFFER' && m.ready);
  assert.ok(steady.every((m) => m.preparedSeconds >= 4), 'cooldown must not drain the recognition lead');
  assert.ok(latest().until >= 304, 'half-second inferences must sustain five minutes of playback');
  assert.equal(latest().segmentId, 1, 'continuous playback must retain one contiguous segment');
});
await session(async ({ advance, latest, seek, play, requests, jump }) => {
  await advance(10);
  seek(590); await advance(20);
  assert.equal(latest().until, 600);
  assert.equal(latest().ready, true, 'partial final windows must complete startup near EOF');
  seek(592); await advance(1);
  const count = requests.length;
  play(); await advance(6);
  assert.equal(requests.length, count, 'fully recognized EOF must stay idle');
  jump(200); await advance(10);
  assert.ok(latest().from <= 200 && latest().until > 200, 'fallback clock discontinuity detection must still recover real seeks');
});
await session(async ({ advance, latest, seek, lagClock }) => {
  await advance(10);
  seek(100); await advance(10);
  const cached = latest().segmentId;
  assert.equal(latest().ready, true);
  seek(0); lagClock(5000); await advance(1);
  seek(100); await advance(5);
  assert.equal(latest().segmentId, cached, 'a delayed pre-seek clock must not reselect the old cached position');
  assert.equal(latest().ready, true);
});
await session(async ({ advance, latest, play, slow, setRate }) => {
  await advance(10);
  slow(300); setRate(2); play(); await advance(60);
  assert.ok(latest().until >= 124, 'CPU pacing must sustain recognition at double playback speed');
  assert.equal(latest().segmentId, 1, 'a playback-rate change must not look like a seek');
});
await session(async ({ advance, play, requests, boundary, seek, messages }) => {
  await advance(10);
  assert.equal(requests[0].seconds, 8, 'identification must use enough context to disambiguate shared phrases');
  assert.ok(requests.slice(1).every((r) => r.seconds === 4), 'within-ayah recognition must retain the cheaper four-second window');
  const before = requests.length;
  boundary(true); play(); await advance(6);
  assert.ok(requests.slice(before).some((r) => r.seconds === 8), 'ayah boundaries must use longer context to retain short ayahs');
  const buffers = messages.filter((m) => m.type === 'BUFFER' && m.until != null);
  assert.ok(buffers.every((b, i) => !i || b.until >= buffers[i - 1].until), 'changing window length must never shrink coverage');
  const count = requests.length;
  boundary(false); seek(100); await advance(10);
  assert.equal(requests[count].seconds, 8, 'a seek must re-identify from a longer window');
});
await session(async ({ advance, seek, latest, messages, multipleAyahs }) => {
  await advance(10);
  multipleAyahs(true); seek(100); await advance(15);
  assert.equal(latest().ready, true);
  assert.equal(latest().requiredSeconds, 12, 'several consecutive ayahs must not trigger the ambiguity extension');
  assert.equal(messages.some((m) => m.captureEpoch === 2 && m.requiredSeconds === 28), false);
});
await session(async ({ advance, seek, latest, messages, ambiguity, play }) => {
  await advance(10);
  ambiguity(['2:126', '14:35']); seek(100); await advance(5);
  assert.equal(latest().ready, false, 'competing matches at the first twelve-second gate must remain hidden');
  assert.equal(latest().requiredSeconds, 28);
  const extended = messages.find((m) => m.captureEpoch === 2 && m.requiredSeconds === 28 && !m.ready);
  assert.ok(extended);
  assert.ok(extended.preparedSeconds >= 12, 'do not extend before the first twelve seconds have been checked');
  ambiguity([]); await advance(15);
  const firstReady = messages.find((m) => m.captureEpoch === 2 && m.type === 'BUFFER' && m.ready);
  assert.equal(firstReady.requiredSeconds, 28, 'once extended, finish the whole 28-second check even if ambiguity resolves sooner');
  assert.ok(firstReady.until >= 128);
  play(); await advance(20);
  assert.equal(latest().requiredSeconds, 12, 'ordinary playback must return to twelve-second look-ahead');
});
await session(async ({ advance, seek, latest, messages, ambiguity }) => {
  await advance(10);
  ambiguity(['2:126', '14:35']); seek(100); await advance(1);
  ambiguity([]); await advance(15);
  assert.equal(latest().ready, true);
  assert.equal(messages.some((m) => m.captureEpoch === 2 && m.requiredSeconds === 28), false,
    'ambiguity already resolved inside the initial twelve seconds must not lengthen the check');
  ambiguity(['2:126', '14:35']); seek(590); await advance(15);
  assert.equal(latest().ready, true, 'an extended check near EOF must only require the audio that exists');
  assert.equal(latest().until, 600);
});
await session(async ({ advance, seek, latest, messages, ambiguity }) => {
  await advance(10);
  ambiguity(['2:126']); seek(100); await advance(15);
  assert.equal(latest().ready, true);
  assert.equal(latest().requiredSeconds, 12, 'one definite location must retain the twelve-second check');
  ambiguity(['2:126', '2:126']); seek(200); await advance(15);
  assert.equal(latest().ready, true);
  assert.equal(messages.some((m) => m.requiredSeconds === 28), false, 'duplicate observations of one location are not multiple matches');
});
console.log('CPU scheduler: cached replay, slow inference, pacing, EOF, stale clocks and conditional 12/28-second seek checks passed.');
