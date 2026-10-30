// Real download-only helper + browser WASM + media-clock display; no GPU ASR
// and no tab capture. The playhead is paused while future audio is recognized.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const id = [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const audio = readFileSync(resolve(root, 'server/cache/gt_7_1.mp3'));
const server = createServer((req, res) => {
  if (req.url === '/audio.mp3') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${audio.length}`;
    res.writeHead(range ? 206 : 200, headers); res.end(audio.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>CPU look-ahead test</title><video controls src="/audio.mp3"></video>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser, helper;
try {
  let occupied = false;
  try { await fetch('http://127.0.0.1:8790/health'); occupied = true; } catch {}
  if (occupied && !process.env.USE_RUNNING_AUDIO_HELPER) throw new Error('Port 8790 is in use. Set USE_RUNNING_AUDIO_HELPER=1 to reuse it.');
  if (!occupied) {
    helper = spawn(process.env.PYTHON_PATH || resolve(root, 'server/.venv/bin/python'), ['-u', 'audio_server.py'],
    { cwd: resolve(root, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Audio-only helper did not start')), 15000);
    helper.stdout.on('data', (data) => {
      if (data.toString().includes('listening on')) { clearTimeout(timeout); resolve(); }
    });
    helper.once('error', reject);
    helper.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Helper exited: ${code}`)); });
    helper.stderr.on('data', (data) => console.error('audio helper:', data.toString().trim()));
  });
  }
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser',
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${id}`,
      '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  await sw.evaluate(() => {
    chrome.tabCapture.getMediaStreamId = async () => { throw new Error('Look-ahead must not capture the tab'); };
    globalThis.bufferCount = 0;
    globalThis.recognitionCount = 0;
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'BUFFER') {
        globalThis.bufferCount++;
        if (!m.ready && m.cues?.length) globalThis.earlyCue = true;
        if (m.ready && globalThis.firstReadyUntil == null) globalThis.firstReadyUntil = m.until;
      }
      if (m.type === 'DEBUG' && m.text.includes('recognizing ahead')) globalThis.recognitionCount++;
    });
  });
  const observer = await browser.newPage();
  await observer.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await observer.select('#recognition', 'browser');
  assert.equal(await observer.$eval('#cpuLookahead', (el) => el.checked), true);
  assert.equal(await observer.$eval('#cpuHighlight', (el) => el.checked), true);
  // Exercise enabling alignment mid-session as well as the default UI value.
  await observer.click('#cpuHighlight');
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('video').duration > 0);
  await page.$eval('video', (v) => { v.currentTime = 22; });
  await page.waitForFunction(() => !document.querySelector('video').seeking && document.querySelector('video').currentTime > 21);
  await page.bringToFront();
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
  await observer.waitForFunction(async () => {
    const { qltState: s } = await chrome.storage.session.get('qltState');
    if (s?.error) return true;
    return s?.backend === 'lookahead' && s.buffered?.until >= 37 && s.debug?.includes('buffer ready');
  }, { timeout: 90000, polling: 200 }).catch(async (error) => {
    console.error(await observer.evaluate(() => chrome.storage.session.get('qltState'))); throw error;
  });
  const state = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState);
  assert.equal(state.error, null);
  assert.equal(await sw.evaluate(() => !!globalThis.earlyCue), false, 'partial startup buffers must not expose ayahs');
  assert.ok(await sw.evaluate(() => globalThis.firstReadyUntil >= 34), 'prepare twelve seconds ahead of the paused 22s playhead');
  console.log('Look-ahead cues:', state.buffered.cues.map((c) => ({ ref: c.match.ref, at: c.t0 })));
  await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot
    ?.querySelector('#where').textContent.includes('1:5'), { timeout: 10000 });
  assert.equal((await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState)).lastMatch.ref, '1:5',
    'recognizing future verses must not display them before the playhead reaches them');
  await page.waitForFunction(() => document.querySelector('video').paused);
  const count = await sw.evaluate(() => globalThis.bufferCount);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await sw.evaluate(() => globalThis.bufferCount), count, 'a filled paused buffer must stop inference');
  const inferenceCount = await sw.evaluate(() => globalThis.recognitionCount);
  await observer.evaluate(() => chrome.storage.local.set({ qltCPUHighlight: true }));
  await page.waitForFunction(() => {
    const words = [...document.querySelector('#__qlt_card_host__').shadowRoot.querySelectorAll('#arabic .w')];
    return words.findIndex((w) => w.classList.contains('cur')) === 1;
  }, { timeout: 10000 });
  assert.equal(await sw.evaluate(() => globalThis.recognitionCount), inferenceCount,
    'enabling precise CPU word timing must reuse cached CTC scores, not run ASR again');
  assert.equal(await page.evaluate(() => document.querySelector('#__qlt_card_host__').shadowRoot
    .querySelector('#debug').classList.contains('hidden')), true, 'production diagnostics are hidden');
  await page.$eval('video', (v) => { v.currentTime = 30; });
  await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot
    ?.querySelector('#where').textContent.includes('1:6'), { timeout: 60000 });
  const oldEpoch = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState.captureEpoch);
  await page.evaluate(() => history.pushState(null, '', '/next-video'));
  await page.waitForFunction(() => {
    const button = document.querySelector('#__qlt_card_host__')?.shadowRoot?.querySelector('#restartCpu');
    return button && !button.classList.contains('hidden') && !button.disabled;
  });
  await page.evaluate(() => document.querySelector('#__qlt_card_host__').shadowRoot.querySelector('#restartCpu').click());
  await observer.waitForFunction(async (oldEpoch) => {
    const { qltState: state } = await chrome.storage.session.get('qltState');
    if (state?.error) return true;
    return state?.captureEpoch > oldEpoch && state.buffered?.key.endsWith('/next-video') && state.lastMatch?.ref === '1:6';
  }, { timeout: 60000, polling: 200 }, oldEpoch).catch(async (error) => {
    console.error('Restart state:', await observer.evaluate(() => chrome.storage.session.get('qltState')));
    console.error('Restart card:', await page.evaluate(() => {
      const s = document.querySelector('#__qlt_card_host__')?.shadowRoot;
      return { status: s?.querySelector('#status').textContent, where: s?.querySelector('#where').textContent };
    }));
    throw error;
  });
  assert.equal((await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState)).error, null);
  await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  await observer.waitForFunction(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length === 0,
    { timeout: 15000, polling: 100 });
  console.log('Automatic helper discovery, CPU future recognition, timed display, bounded idle work and seek recovery passed.');
} finally {
  await browser?.close();
  helper?.kill('SIGTERM');
  server.closeAllConnections(); server.close();
}
