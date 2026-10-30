// Exercise production isolated capture and threaded inference, with no API overrides.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const dist = resolve(import.meta.dirname, '../dist');
const id = [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const audio = await readFile(new URL('../server/cache/gt_7_1.mp3', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/audio.mp3') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(audio);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><video src="/audio.mp3" controls></video>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser',
    headless: true, ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${id}`,
      '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.$eval('video', (v) => v.play());
  await page.bringToFront();
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ qltRecognition: 'browser', qltCPULookahead: false });
    await chrome.action.openPopup();
  });
  const popup = await browser.waitForTarget((t) => t.url() === `chrome-extension://${id}/src/popup/popup.html`);
  const observer = await popup.asPage();
  assert.equal(await observer.evaluate(() => crossOriginIsolated), true);
  await observer.waitForFunction(() => document.querySelector('#recognition').value === 'browser');
  // Programmatic openPopup does not grant activeTab's URL access like a real
  // toolbar click, so send the button's START message directly.
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
  await observer.waitForFunction(async () => {
    const { qltState: s } = await chrome.storage.session.get('qltState');
    if (s?.error) throw new Error(s.error);
    return s?.lastMatch;
  }, { timeout: 60000, polling: 100 });
  const state = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState);
  const threads = await observer.evaluate(() => Math.min(4, navigator.hardwareConcurrency || 1));
  assert.match(state.debug, new RegExp(`^ASR ${threads}t · `));
  assert.equal(state.backend, 'browser');
  assert.equal(state.error, null);
  console.log('Production isolated tab capture and threaded recognition passed:', state.debug);
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  await observer.waitForFunction(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length === 0);
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
