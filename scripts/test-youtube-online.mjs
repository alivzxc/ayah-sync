// Opt-in network smoke test. Unlike test:youtube, this requires a real YouTube
// download (not a live fallback) and is expected to fail if YouTube blocks it.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const url = new URL(process.argv[2] || 'https://www.youtube.com/watch?v=jEUu_bfiJHQ');
assert.ok(url.protocol === 'https:' && (/(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === 'youtu.be'));
const id = [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${id}`,
    '--autoplay-policy=no-user-gesture-required'] });
try {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  await sw.evaluate(() => {
    const original = fetch;
    globalThis.fetch = (input, init) => String(input).includes(':8790/health')
      ? Promise.reject(new Error('Helper disabled in browser-only test')) : original(input, init);
    return chrome.storage.local.set({ qltRecognition: 'browser', qltCPULookahead: true });
  });
  const observer = await browser.newPage();
  await observer.goto(`chrome-extension://${new URL(target.url()).host}/src/popup/popup.html`);
  const page = await browser.newPage();
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => Number.isFinite(document.querySelector('video')?.duration) &&
    document.querySelector('video').duration > 0, { timeout: 30000 });
  await page.bringToFront();
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
  await observer.waitForFunction(async () => {
    const { qltState: state } = await chrome.storage.session.get('qltState');
    return state?.status === 'error' || state?.backend === 'browser' || state?.buffered?.ready;
  }, { timeout: 170000, polling: 500 });
  const result = await observer.evaluate(async () => {
    const { qltState: state } = await chrome.storage.session.get('qltState');
    return { backend: state.backend, source: state.cpuAudioSource, error: state.error, ready: !!state.buffered?.ready };
  });
  if (!result.ready) console.log('Preparation diagnostics:', await observer.evaluate(async () => {
    const { qltState: s } = await chrome.storage.session.get('qltState');
    return { status: s.status, debug: s.debug, activity: s.cpuActivity };
  }), 'Video clock:', await page.$eval('video', (v) => ({ time: v.currentTime, duration: v.duration })));
  assert.deepEqual(result, { backend: 'lookahead', source: 'youtubejs', error: null, ready: true },
    'YouTube blocked browser downloading or no look-ahead was prepared; a live fallback does not count as success');
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  // The observer tab is in the background: rAF polling can stop while async
  // disk cleanup runs, even though the offscreen context closes successfully.
  await observer.waitForFunction(async () =>
    !(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length, { timeout: 15000, polling: 250 });
  assert.deepEqual(await observer.evaluate(async () => {
    const directories = [], root = await navigator.storage.getDirectory();
    for await (const key of root.keys()) if (key.startsWith('cpu-audio-')) directories.push(key);
    return directories;
  }), [], 'Stop must finish deleting compressed audio before closing the offscreen document');
  assert.deepEqual(await sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id)), []);
  console.log('Real YouTube.js audio download, native decoding, CPU model inference, 12-second look-ahead and Stop cleanup passed (helper disabled).');
} finally { await browser.close(); }
