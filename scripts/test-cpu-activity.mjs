import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let receive, saved;
const event = { addListener() {} };
const context = vm.createContext({ console, Date, URL, Object, Set, Promise, setTimeout, clearTimeout,
  chrome: {
    storage: { onChanged: event, session: { async get() { return {}; }, async set(value) { saved = structuredClone(value); } } },
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { receive = fn; } },
      onInstalled: event, onStartup: event, async sendMessage() {} },
    tabs: { onActivated: event, onRemoved: event, async sendMessage() {} }, windows: { onFocusChanged: event },
  },
});
vm.runInContext(readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8'), context);
await new Promise((r) => setImmediate(r));
vm.runInContext("Object.assign(state, { capturing: true, backend: 'lookahead', tabId: 1, displayTabId: 1 })", context);
const emit = (message) => receive(message, { url: 'chrome-extension://test/src/offscreen/offscreen.html' }, () => {});
emit({ type: 'STATUS', status: 'loading-model', detail: 'CPU sync · downloading audio in your browser · 10%…' });
emit({ type: 'STATUS', status: 'loading-model', detail: 'CPU sync · downloading audio in your browser · 75%…' });
assert.equal(vm.runInContext('state.cpuActivity.length', context), 1, 'download progress updates one history entry');
assert.match(vm.runInContext('state.cpuActivity[0].text', context), /75%/);
emit({ type: 'DEBUG', text: 'ASR 4t · 100ms · identifying' });
assert.equal(vm.runInContext('state.cpuActivity.length', context), 1, 'inference ticks must not flood the activity history');
emit({ type: 'CPU_AUDIO_SOURCE', source: 'youtubejs' });
assert.equal(vm.runInContext('state.cpuAudioReady', context), true);
assert.match(vm.runInContext('state.cpuActivity.at(-1).text', context), /First audio batch ready/);
emit({ type: 'CPU_AUDIO_BATCH', progress: { phase: 'background', stage: 'download', start: 180, end: 1980, received: 5, total: 10 } });
assert.match(vm.runInContext('state.cpuAudioBatch.text', context), /Background audio.*50%/);
emit({ type: 'CPU_AUDIO_BATCH', progress: { phase: 'background', stage: 'ready', start: 180, end: 1980 } });
emit({ type: 'CPU_AUDIO_BATCH', progress: { phase: 'background', stage: 'session', start: 1980, end: 3780 } });
assert.equal(vm.runInContext('state.cpuAudioBatch.lastReady.end', context), 1980, 'cached progress survives the next background job');
vm.runInContext("for (const phase of 'abcdefghijklmnop') recordCpuActivity('Phase ' + phase); recordCpuActivity('Fetching https://example.test/audio?token=secret')", context);
assert.equal(vm.runInContext('state.cpuActivity.length', context), 8, 'history must stay bounded');
assert.equal(vm.runInContext('state.cpuActivity.at(-1).text', context), 'Fetching [URL]');
vm.runInContext('flushState()', context);
assert.equal(saved.qltState.cpuActivity.length, 8, 'the popup can recover history from session state when reopened');
vm.runInContext("state.backend = 'helper'; recordCpuActivity('GPU activity must not enter this log')", context);
assert.equal(vm.runInContext('state.cpuActivity.at(-1).text', context), 'Fetching [URL]');
console.log('CPU activity progress coalescing, bounded session history, URL redaction and GPU isolation passed.');
