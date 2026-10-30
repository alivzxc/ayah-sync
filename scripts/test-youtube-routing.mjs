import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let receive, rules = [], saved;
const event = { addListener() {} };
const runtimeURL = (path) => `chrome-extension://test-extension/${path}`;
const context = vm.createContext({ console, Date, URL, Object, Set, Promise, setTimeout, clearTimeout,
  chrome: {
    storage: { onChanged: event, session: { async get() { return {}; }, async set(value) { saved = structuredClone(value); } } },
    runtime: { id: 'test-extension', getURL: runtimeURL, onMessage: { addListener(fn) { receive = fn; } },
      onInstalled: event, onStartup: event },
    tabs: { onActivated: event, onRemoved: event }, windows: { onFocusChanged: event },
    declarativeNetRequest: { async updateSessionRules(change) {
      rules = rules.filter((r) => !change.removeRuleIds.includes(r.id)); rules.push(...structuredClone(change.addRules));
    } },
  },
});
vm.runInContext(readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8'), context);
await new Promise((r) => setImmediate(r));
vm.runInContext("Object.assign(state, { capturing: true, backend: 'lookahead' })", context);
const sender = { url: runtimeURL('src/offscreen/offscreen.html') };
const sessionA = '00000000-0000-4000-8000-000000000001', sessionB = '00000000-0000-4000-8000-000000000002';
const request = (enabled, sessionId, source = sender) => new Promise((resolve) =>
  receive({ type: 'CPU_YT_NETWORK', enabled, sessionId }, source, resolve));
assert.equal((await request(true, sessionA, { url: 'https://www.youtube.com/watch?v=abcdefghijk', tab: { id: 1 } })).ok, false);
assert.equal((await request(true, sessionA, { url: runtimeURL('src/popup/popup.html') })).ok, false);
assert.equal((await request(true, 'invalid')).ok, false);
assert.equal((await request(true, sessionA)).ok, true);
assert.equal(rules.length, 1);
assert.deepEqual(rules[0].condition.initiatorDomains, ['test-extension']);
assert.deepEqual(rules[0].condition.requestDomains, ['youtube.com', 'googlevideo.com']);
assert.equal(saved.qltState.cpuNetworkSession, sessionA);
assert.equal((await request(true, sessionB)).ok, true);
assert.equal((await request(false, sessionA)).ok, true);
assert.equal(rules.length, 1, 'stale download cleanup must not disable a newer source');
assert.equal((await request(false, sessionB)).ok, true);
assert.equal(rules.length, 0);
vm.runInContext("state.backend = 'helper'", context);
assert.equal((await request(true, sessionA)).ok, false, 'GPU/helper mode cannot enable the YouTube.js network bridge');
assert.equal(rules.length, 0);
console.log('CPU-only network rule authorization, extension-scoped headers and stale-source ownership checks passed.');
