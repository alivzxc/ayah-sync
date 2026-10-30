import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let receive;
const messages = [], cards = [], timers = new Map();
let timerId = 0;
const event = { addListener() {} };
const context = vm.createContext({ console, Date, URL, Object, Set, Promise,
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  chrome: {
    storage: { onChanged: event, session: { async get() { return {}; }, async set() {} } },
    runtime: { onMessage: { addListener(fn) { receive = fn; } }, onInstalled: event, onStartup: event,
      async sendMessage(msg) { messages.push(structuredClone(msg)); } },
    tabs: { onActivated: event, onRemoved: event,
      async sendMessage(tabId, msg) { cards.push({ tabId, ...structuredClone(msg) }); } },
    windows: { onFocusChanged: event },
  },
});
vm.runInContext(readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8'), context);
await new Promise((r) => setImmediate(r));
vm.runInContext(`Object.assign(state, { capturing: true, backend: 'browser', tabId: 1, displayTabId: 1,
  captureEpoch: 5, lastMatch: { ref: '1:2' } }); lastBroadcast = Date.now();`, context);
receive({ type: 'DEBUG', text: 'ASR 4t · identifying' }, {}, () => {});
await new Promise((r) => setImmediate(r));
assert.equal(timers.size, 1, 'ordinary debug broadcasts remain coalesced');
receive({ type: 'RESULT', captureEpoch: 4, match: { ref: '1:3' } }, {}, () => {});
await new Promise((r) => setImmediate(r));
assert.equal(vm.runInContext('state.lastMatch.ref', context), '1:2', 'pre-seek results are rejected without a clock');
receive({ type: 'RESULT', captureEpoch: 5, match: { ref: '1:3' } }, {}, () => {});
await new Promise((r) => setImmediate(r));
assert.ok(cards.some((m) => m.type === 'CARD_UPDATE' && m.match.ref === '1:3'));
assert.ok(messages.some((m) => m.type === 'STATE' && m.state.lastMatch.ref === '1:3'),
  'a CPU ayah switch reaches the popup immediately, without its 400ms debug throttle');
assert.equal(timers.size, 0, 'the urgent ayah update cancels the older coalesced broadcast');
receive({ type: 'HIGHLIGHT', captureEpoch: 4, highlight: { ref: '1:3', word: 2 } }, {}, () => {});
await new Promise((r) => setImmediate(r));
assert.ok(!cards.some((m) => m.type === 'CARD_HIGHLIGHT'), 'stale word evidence is also rejected');
console.log('Immediate CPU ayah delivery and explicit seek-epoch routing checks passed.');
