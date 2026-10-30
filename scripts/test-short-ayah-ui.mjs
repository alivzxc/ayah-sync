// Renderer controls only: synthetic cues + media clock, no recognition/helper.
// Test both the legacy shim harness and the actual installed extension.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const fixture = JSON.parse(readFileSync(resolve(root, 'harness/short-ayahs.json'), 'utf8'));
const wav = Buffer.alloc(44 + 8 * 16000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const server = createServer((req, res) => {
  if (req.url === '/audio.wav') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const from = range ? Number(range[1]) : 0;
    const until = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
      'Content-Length': until - from + 1, ...(range ? { 'Content-Range': `bytes ${from}-${until}/${wav.length}` } : {}) });
    res.end(wav.subarray(from, until + 1));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Native CPU renderer test</title><video controls src="/audio.wav" style="width:640px;height:360px"></video>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mediaOrigin = `http://127.0.0.1:${server.address().port}`;
const harness = spawn(process.execPath, ['harness/serve.mjs'], { cwd: root, env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
async function observe(page) {
  await page.evaluate(() => {
    globalThis.seen = [];
    globalThis.cardObserver?.disconnect();
    const root = document.querySelector('#__qlt_card_host__').shadowRoot;
    const record = () => {
      const where = root.querySelector('#where').textContent;
      if (/112:\d/.test(where) && seen.at(-1)?.where !== where) seen.push({ at: document.querySelector('video').currentTime, where });
    };
    globalThis.cardObserver = new MutationObserver(record);
    cardObserver.observe(root, { subtree: true, childList: true, characterData: true });
    record(); // Include the initial render, not just subsequent mutations.
  });
}
async function play(page, expected, shortStart = 2) {
  await page.bringToFront();
  await observe(page);
  await page.$eval('video', (v) => v.play());
  await page.waitForFunction(() => document.querySelector('video').currentTime > 4.1, { timeout: 10000 });
  await page.$eval('video', (v) => v.pause());
  const seen = await page.evaluate(() => seen);
  assert.deepEqual(seen.map((s) => s.where.match(/112:\d/)[0]), expected);
  if (expected.includes('112:2')) {
    const short = seen.find((s) => s.where.includes('112:2'));
    assert.ok(short.at >= shortStart && short.at < 2.4, `short cue was displayed at ${short.at}s`);
  }
  return seen;
}
try {
  const harnessOrigin = await new Promise((resolve, reject) => {
    let output = '';
    harness.stdout.on('data', (b) => {
      output += b;
      const match = /harness on (http:\/\/localhost:\d+)/.exec(output);
      if (match) resolve(match[1]);
    });
    harness.once('error', reject);
    harness.once('exit', (code) => reject(Error(`Harness exited: ${code}`)));
  });
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const query = new URLSearchParams({ buffer: '/harness/short-ayahs.json', media: mediaOrigin + '/audio.wav' });
  await page.goto(`${harnessOrigin}/card?${query}`);
  await page.waitForFunction(() => window.__probe?.()?.where.includes('112:1'));
  assert.equal(await page.evaluate(() => chrome.runtime.id), 'ayah-sync-harness');
  await play(page, ['112:1', '112:2', '112:3', '112:4']);
  assert.deepEqual(await page.evaluate(() => __qlt.sent.filter((m) => m.type === 'BUFFER_POSITION').map((m) => m.match.ref)),
    ['112:1', '112:2', '112:3', '112:4']);
  await page.close();

  // Legacy whole-timeline mode must remain usable too (without cached media).
  const legacy = await browser.newPage();
  await legacy.setRequestInterception(true);
  legacy.on('request', (r) => new URL(r.url()).pathname === '/cache/__ui-test.json'
    ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ duration: 8,
      ayahs: fixture.cues.map((c, i) => ({ ...c.match, t0: c.t0, t1: fixture.cues[i + 1]?.t0 ?? 8, w: [] })) }) })
    : r.continue());
  await legacy.goto(`${harnessOrigin}/card?${new URLSearchParams({ tl: '__ui-test.json', media: mediaOrigin + '/audio.wav' })}`);
  await legacy.waitForFunction(() => window.__probe?.()?.where.includes('112:1'));
  await legacy.close();

  // Never inject the installed content script into a shimmed harness page:
  // their replacement/lifecycle events would dispose one another.
  await browser.close();
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      '--autoplay-policy=no-user-gesture-required'] });

  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  await sw.evaluate(() => chrome.storage.local.set({ qltRecognition: 'browser', qltCPUHighlight: false }));
  const native = await browser.newPage();
  await native.goto(mediaOrigin + '/');
  await native.waitForFunction(() => document.querySelector('video').duration > 0);
  await native.bringToFront();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  await sw.evaluate(async (id) => {
    for (let i = 0; i < 40; i++) {
      try { if ((await chrome.tabs.sendMessage(id, { type: 'CONTENT_PING' }))?.ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Native content script not ready');
  }, tabId);
  for (const mode of ['complete', 'omitted', 'onset-lead']) {
    await native.$eval('video', (v) => { v.pause(); v.currentTime = 0; });
    await native.waitForFunction(() => !document.querySelector('video').seeking);
    const cues = fixture.cues.filter((c) => mode !== 'omitted' || c.match.ref !== '112:2').map((c) =>
      mode === 'onset-lead' && c.match.ref === '112:2' ? { ...c, t0: 1.88,
        words: [{ word: 0, start: 2, end: 2.3 }, { word: 1, start: 2.3, end: 2.4 }] } : c);
    await sw.evaluate(async ({ id, cues, key }) => {
      await chrome.tabs.sendMessage(id, { type: 'CARD_HIDE' });
      await chrome.tabs.sendMessage(id, { type: 'CARD_SHOW', mode: 'lookahead', status: 'listening' });
      await chrome.tabs.sendMessage(id, { type: 'CARD_BUFFER', buffer: { key, duration: 8, from: 0, until: 8,
        cueFrom: 0, cueUntil: 8, ready: true, segmentId: 1, captureEpoch: 1,
        ranges: [{ id: 1, from: 0, until: 8 }], marks: cues.map((c) => c.t0), cues } });
    }, { id: tabId, cues, key: native.url() });
    await native.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot.querySelector('#where').textContent.includes('112:1'));
    const seen = await play(native, mode === 'omitted' ? ['112:1', '112:3', '112:4'] : ['112:1', '112:2', '112:3', '112:4'],
      mode === 'onset-lead' ? 1.88 : 2);
    if (mode === 'onset-lead') assert.ok(seen.find((s) => s.where.includes('112:2')).at < 2,
      'the real renderer must switch at the supplied onset lead, not at the first word start/end');
  }
  await sw.evaluate(() => chrome.storage.local.set({ qltCPUHighlight: true }));
  const partial = { ...fixture.cues[0], words: [
    { word: 0, start: 0, end: 0.8 }, { word: 1, start: 0.9, end: 1.3 }, { word: 2, start: 1.4, end: 1.8 },
  ], highlightWords: [{ word: 2, start: 1.45, end: 1.7 }] };
  for (const [time, expected] of [[0.4, 0], [1.5, 2], [1.75, -1]]) {
    await native.$eval('video', (v, time) => { v.pause(); v.currentTime = time; }, time);
    await native.waitForFunction(() => !document.querySelector('video').seeking);
    await sw.evaluate(async ({ id, cue, key }) => {
      await chrome.tabs.sendMessage(id, { type: 'CARD_BUFFER', buffer: { key, duration: 8, from: 0, until: 8,
        cueFrom: 0, cueUntil: 8, ready: true, segmentId: 1, captureEpoch: 1,
        ranges: [{ id: 1, from: 0, until: 8 }], marks: [0], cues: [cue] } });
    }, { id: tabId, cue: partial, key: native.url() });
    await native.waitForFunction((expected) => {
      const words = [...document.querySelector('#__qlt_card_host__').shadowRoot.querySelectorAll('#arabic .w')];
      return words.findIndex((w) => w.classList.contains('cur')) === expected;
    }, { timeout: 5000 }, expected);
  }
  console.log('Harness + native extension: short cues, pre-first-word onset switching and no invented upstream cues passed.');
} finally {
  await browser?.close(); harness.kill('SIGTERM'); server.closeAllConnections(); server.close();
}
