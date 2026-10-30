// Opt-in real network + real SABR partial containers + native decoder. This
// isolates the audio source from YouTube's flaky headless visual-player seeks;
// it does NOT claim an end-to-end test of that site's player or the ASR model.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const asset = readdirSync(resolve(dist, 'assets')).find((f) => /^youtube-source-.*\.js$/.test(f));
const options = { videoId: process.env.CPU_TEST_VIDEO || '3RmK1R_BAKw', expectedDuration: Number(process.env.CPU_TEST_DURATION || 8208.61),
  position: Number(process.env.CPU_TEST_POSITION || 3600) };
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
  protocolTimeout: 360000, ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
let sw;
try {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  sw = await target.worker();
  // Test-only network authorization: production accepts this from the CPU
  // offscreen document only. No production authorization checks are bypassed.
  await sw.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8791], addRules: [{ id: 8791, priority: 1,
    condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['youtube.com', 'googlevideo.com'], resourceTypes: ['xmlhttprequest'] },
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' },
      { header: 'referer', operation: 'set', value: 'https://www.youtube.com/' }] } }] }));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(target.url()).host}/src/popup/popup.html`);
  const initial = await page.evaluate(async ({ asset, options }) => {
    const { prepareYoutubeAudio } = await import(chrome.runtime.getURL(`assets/${asset}`));
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg) => msg.type === 'CPU_YT_NETWORK' ? Promise.resolve({ ok: true }) : original(msg);
    globalThis.controller = new AbortController(); globalThis.progress = [];
    globalThis.source = await prepareYoutubeAudio({ ...options, signal: controller.signal,
      onProgress(p) { progress.push(p); } });
    const pcm = await source.window(options.position);
    return { records: source.records.map(({ start, end }) => ({ start, end })), samples: pcm.audio.length,
      start: pcm.start, nonzero: pcm.audio.some((x) => Math.abs(x) > 0.001) };
  }, { asset, options });
  assert.ok(initial.records.some((r) => r.end - r.start <= 180 && r.start <= options.position && r.end > options.position));
  assert.equal(initial.samples, 20 * 16000); assert.equal(initial.start, options.position); assert.equal(initial.nonzero, true);
  console.log('Real three-minute startup at', options.position, 'seconds:', initial.records);
  await page.waitForFunction(() => progress.some((p) => p.phase === 'background' && ['ready', 'failed'].includes(p.stage)),
    { timeout: 330000, polling: 500 });
  const background = await page.evaluate(() => progress.find((p) => p.phase === 'background' && ['ready', 'failed'].includes(p.stage)));
  if (background.stage === 'failed') console.log('Batch failure:', await page.evaluate(() => ({
    start: source.lastFailure?.start, end: source.lastFailure?.end,
    error: source.lastFailure?.error?.message?.replace(/https?:\/\/\S+/g, '[URL]'), progress: progress.slice(-5),
  })));
  assert.equal(background.stage, 'ready', 'real background SABR batch must complete');
  assert.equal(background.end - background.start, Math.min(1800, options.expectedDuration - background.start));
  const crossing = await page.evaluate(async (time) => {
    const pcm = await source.window(time);
    return { start: pcm.start, length: pcm.audio.length, nonzero: pcm.audio.some((x) => Math.abs(x) > 0.001) };
  }, background.start - 2);
  assert.equal(crossing.length, 20 * 16000); assert.equal(crossing.nonzero, true);
  console.log('Real background batch', background.start, 'to', background.end, 'and 20s cross-boundary decoding passed.');
  const seeks = await page.evaluate(async (duration) => {
    const tail = await source.window(duration - 10);
    const beginning = await source.window(0);
    return { tailSamples: tail.audio.length, firstSamples: beginning.audio.length,
      foreground: progress.filter((p) => p.phase === 'seek' && p.stage === 'ready').map(({ start, end }) => ({ start, end })) };
  }, options.expectedDuration);
  assert.ok(Math.abs(seeks.tailSamples - 10 * 16000) <= 1);
  assert.equal(seeks.firstSamples, 20 * 16000);
  assert.ok(seeks.foreground.every((r) => r.end - r.start <= 180));
  console.log('Real uncached seek priority and final partial window passed:', seeks.foreground);
  await page.evaluate(() => { controller.abort(); source.close(); });
  await page.waitForFunction(async () => {
    if (document.querySelector('iframe')) return false;
    const root = await navigator.storage.getDirectory();
    for await (const key of root.keys()) if (key.startsWith('cpu-audio-')) return false;
    return true;
  }, { timeout: 15000 });
  console.log('Real batch-source network cancellation, sandbox and disk-cache cleanup passed.');
} finally {
  try { await sw?.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8791] })); } catch {}
  await browser.close();
}
