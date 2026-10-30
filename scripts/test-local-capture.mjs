// Real tab capture → WASM worker → live card, with all helper sockets forbidden.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const extensionId = [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const audioPath = resolve(root, 'server/cache/gt_7_1.mp3');
if (!existsSync(audioPath)) {
  const response = await fetch('https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/1.mp3');
  if (!response.ok) throw new Error(`Test audio download failed: ${response.status}`);
  await mkdir(resolve(root, 'server/cache'), { recursive: true });
  await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
}
const audio = readFileSync(audioPath);
const server = createServer((req, res) => {
  if (req.url === '/audio.mp3') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${audio.length}`;
    res.writeHead(range ? 206 : 200, headers);
    res.end(audio.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html',
      'Content-Security-Policy': "font-src 'none'; connect-src 'self'" });
    res.end('<!doctype html><title>Live CPU test</title><video controls src="/audio.mp3"></video>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${extensionId}`,
      '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--no-first-run'], protocolTimeout: 120000 });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const worker = await target.worker();
  await worker.evaluate(() => {
    globalThis.helperAttempts = 0;
    globalThis.WebSocket = class { static OPEN = 1; constructor() { globalThis.helperAttempts++; throw new Error('Helper forbidden in CPU test'); } };
  });
  const origin = `chrome-extension://${new URL(target.url()).host}`;
  const observer = await browser.newPage();
  await observer.goto(`${origin}/src/popup/popup.html`);
  assert.equal(await observer.$eval('#recognition', (el) => el.value), 'helper');
  await worker.evaluate(() => { globalThis.helperAttempts = 0; });
  await observer.select('#recognition', 'browser');
  await observer.click('#cpuLookahead');
  assert.equal((await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'PING_HELPER' }))).disabled, true);
  assert.equal(await worker.evaluate(() => globalThis.helperAttempts), 0,
    'even an explicit helper probe must not open a socket in CPU mode');
  await observer.waitForFunction(() => !document.querySelector('#cpuHighlightSetting').hidden);
  assert.equal(await observer.$eval('#cpuHighlight', (el) => el.checked), false,
    'highlighting defaults off when Auto CPU look-ahead is disabled');
  assert.equal(await observer.$eval('#helperText', (el) => el.textContent), 'CPU');
  assert.equal(await observer.$eval('#syncBtn', (el) => el.textContent), 'Listen live on CPU');
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('video').duration > 0);
  await page.$eval('video', (v) => v.play());
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.5);
  const started = Date.now();
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
  const offscreen = await browser.waitForTarget((t) => t.url().includes('/src/offscreen/offscreen.html'));
  const offscreenSession = await offscreen.createCDPSession();
  await offscreenSession.send('Runtime.evaluate', { expression: `
    globalThis.helperAttempts = 0;
    globalThis.WebSocket = class { static OPEN = 1; constructor() { globalThis.helperAttempts++; throw new Error('Helper forbidden'); } };
  ` });
  await observer.waitForFunction(async () => {
    const { qltState } = await chrome.storage.session.get('qltState');
    if (qltState?.error) throw new Error(qltState.error);
    return !!qltState?.lastMatch;
  }, { timeout: 90000, polling: 250 }).catch(async (error) => {
    console.error('Live state:', await observer.evaluate(() => chrome.storage.session.get('qltState')));
    throw error;
  });
  await observer.waitForFunction(() => document.querySelector('#liveHeading').textContent === 'Listening live',
    { timeout: 5000 });
  const state = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState);
  assert.equal(state.backend, 'browser');
  assert.equal(state.sync.status, 'idle');
  assert.match(state.debug, /^ASR \d+t · /);
  assert.equal(await observer.$eval('#liveHeading', (el) => el.textContent), 'Listening live');
  assert.ok(state.lastMatch.ref.startsWith('1:'));
  await page.waitForFunction((ref) => {
    const s = document.querySelector('#__qlt_card_host__')?.shadowRoot;
    return s?.querySelector('#where').textContent.includes(ref) && !s.querySelector('#verse').classList.contains('hidden');
  }, { timeout: 5000 }, state.lastMatch.ref);
  await page.waitForFunction(() => {
    const debug = document.querySelector('#__qlt_card_host__')?.shadowRoot?.querySelector('#debug');
    return debug?.classList.contains('hidden');
  }, { timeout: 5000 });
  await page.waitForFunction(() => ['QLT-Uthmani', 'QLT-IndoPak', 'QLT-Text'].every((name) =>
    [...document.fonts].some((face) => face.family === name && face.status === 'loaded')),
  { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.querySelector('#__qlt_card_host__').shadowRoot
    .querySelector('style').textContent.includes('@font-face')), false,
  'host pages must not attempt direct extension-URL font loads');
  const card = await page.evaluate(() => {
    const s = document.querySelector('#__qlt_card_host__').shadowRoot;
    return { translation: s.querySelector('#trans').textContent, debug: s.querySelector('#debug').textContent,
      words: s.querySelectorAll('.w.cur').length,
      ribbonHidden: s.querySelector('#ribbon').classList.contains('hidden'),
      seekHidden: s.querySelector('#seek').classList.contains('hidden') };
  });
  assert.ok(card.translation);
  assert.equal(card.debug, '', 'production builds hide CPU diagnostics');
  assert.equal(card.words, 0);
  assert.equal(card.ribbonHidden, true);
  assert.equal(card.seekHidden, true);
  await page.evaluate(() => {
    globalThis.cpuHighlightsSeen = [];
    globalThis.cpuHighlightObserver = new MutationObserver(() => {
      const s = document.querySelector('#__qlt_card_host__')?.shadowRoot;
      const words = s ? [...s.querySelectorAll('.w')] : [];
      const word = words.findIndex((w) => w.classList.contains('cur'));
      if (word >= 0) globalThis.cpuHighlightsSeen.push({ word, at: Date.now() });
    });
    globalThis.cpuHighlightObserver.observe(document.querySelector('#__qlt_card_host__').shadowRoot,
      { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await observer.evaluate(() => chrome.storage.local.set({ qltCPUHighlight: true }));
  console.log('Live CPU ayah:', state.lastMatch.ref, 'first result:', (Date.now() - started) / 1000,
    'seconds · model debug:', state.debug);
  // A first match alone hid the old regression: boundary partials discarded
  // tracking and the card stopped following subsequent verses.
  for (const ref of ['1:4', '1:5', '1:6', '1:7']) {
    await page.waitForFunction((ref) => {
      const s = document.querySelector('#__qlt_card_host__')?.shadowRoot;
      return s?.querySelector('#where').textContent.includes(ref);
    }, { timeout: 20000, polling: 100 }, ref).catch(async (error) => {
      console.error('Card transition failed:', ref, await observer.evaluate(() => chrome.storage.session.get('qltState')));
      throw error;
    });
    console.log('Live card followed:', ref);
  }
  assert.ok(await page.evaluate(() => globalThis.cpuHighlightsSeen.length > 0),
    'enabling CPU highlighting must display actual acoustically supported words');
  await observer.evaluate(() => chrome.storage.local.set({ qltCPUHighlight: false }));
  await page.waitForFunction(() => !document.querySelector('#__qlt_card_host__').shadowRoot.querySelector('.w.cur'));
  assert.equal(await worker.evaluate(() => globalThis.helperAttempts), 0);
  const socketCount = await offscreenSession.send('Runtime.evaluate', { expression: 'globalThis.helperAttempts', returnByValue: true });
  assert.equal(socketCount.result.value, 0);
  const saved = await observer.evaluate(() => chrome.storage.session.get(null));
  assert.ok(!Object.keys(saved).some((k) => k.startsWith('qltLearned_') || k.startsWith('qltTL_')));
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  await observer.waitForFunction(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length === 0,
    { timeout: 10000, polling: 250 });
  console.log('Live CPU, look-ahead-dependent highlighting default, no timelines/helper sockets and cleanup passed.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
