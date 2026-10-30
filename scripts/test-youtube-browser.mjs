// Real packaged MV3 sandbox + the real YouTube.js browser entry point. Network
// failure is deterministic; decoding uses a generated stereo WAV fixture.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const sourceAsset = readdirSync(resolve(dist, 'assets')).find((f) => /^youtube-source-.*\.js$/.test(f));
assert.ok(sourceAsset, 'Build the extension first');
// No network fixture or FFmpeg needed: stereo 8 kHz -> mono 16 kHz also checks
// the native decoder's resampling/downmixing path, not just file loading.
const wav = Buffer.alloc(44 + 24 * 8000 * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 24 * 8000; i++) {
  const sample = Math.sin(i / 8000 * 220 * 2 * Math.PI);
  wav.writeInt16LE(Math.round(sample * 0.2 * 32767), 44 + i * 4);
  wav.writeInt16LE(Math.round(sample * 0.4 * 32767), 46 + i * 4);
}
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
try {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  await sw.evaluate(() => chrome.storage.local.set({ qltRecognition: 'browser' }));
  const origin = `chrome-extension://${new URL(target.url()).host}`;
  const page = await browser.newPage();
  await page.goto(`${origin}/src/popup/popup.html`);
  const sandbox = await page.evaluate(async () => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts'); iframe.src = chrome.runtime.getURL('src/cpu/youtube-sandbox.html');
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sandbox did not load')), 10000);
      const ready = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.type !== 'YOUTUBE_READY') return;
        clearTimeout(timeout); window.removeEventListener('message', ready);
        resolve({ origin: event.origin, parentIsolated: crossOriginIsolated });
      };
      window.addEventListener('message', ready); document.body.append(iframe);
    });
    return result;
  });
  assert.deepEqual(sandbox, { origin: 'null', parentIsolated: true });
  const frame = page.frames().find((f) => f.url().includes('/src/cpu/youtube-sandbox.html'));
  assert.equal(await frame.evaluate(() => !!globalThis.chrome?.runtime?.id), false);
  assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
  assert.equal(await frame.evaluate(() => new Function('return 42')()), 42);
  // CDP evaluations can bypass eval CSP, so inspect the packaged policy instead
  // of treating a DevTools-created Function as a normal extension script.
  assert.doesNotMatch(await page.evaluate(() => chrome.runtime.getManifest().content_security_policy.extension_pages), /(?:^|\s)'unsafe-eval'(?:\s|;|$)/,
    'privileged extension pages must not gain unsafe-eval');
  await page.evaluate(() => document.querySelector('iframe').remove());
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CPU_YT_NETWORK', enabled: true }))).ok, false,
    'a popup must not enable the offscreen-only network bridge');
  const failures = await page.evaluate(async (asset) => {
    const { prepareYoutubeAudio } = await import(chrome.runtime.getURL(`assets/${asset}`));
    const originalMessage = chrome.runtime.sendMessage.bind(chrome.runtime), originalFetch = fetch;
    const toggles = [], urls = [];
    chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'CPU_YT_NETWORK') { toggles.push(message.enabled); return { ok: true }; }
      return originalMessage(message);
    };
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return new Response('blocked', { status: 403 }); };
      let error;
      try { await prepareYoutubeAudio({ videoId: 'jEUu_bfiJHQ', expectedDuration: 306, signal: new AbortController().signal }); }
      catch (e) { error = e.message; }
      if (!error) throw new Error('Blocked download unexpectedly succeeded');
      if (document.querySelector('iframe')) throw new Error('Failed sandbox leaked');
      const abort = new AbortController();
      let markStarted, networkAborted = false;
      const started = new Promise((resolve) => { markStarted = resolve; });
      globalThis.fetch = async (_, { signal }) => {
        markStarted();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          networkAborted = true; reject(new DOMException('Stopped', 'AbortError'));
        }, { once: true }));
      };
      const pending = prepareYoutubeAudio({ videoId: 'jEUu_bfiJHQ', expectedDuration: 306, signal: abort.signal });
      await started; abort.abort();
      try { await pending; } catch {}
      return { error, urls, toggles, networkAborted, frames: document.querySelectorAll('iframe').length };
    } finally { chrome.runtime.sendMessage = originalMessage; globalThis.fetch = originalFetch; }
  }, sourceAsset);
  assert.match(failures.error, /could not download/);
  assert.ok(failures.urls.some((u) => u === 'https://www.youtube.com/sw.js_data'), 'YouTube.js must use the custom browser fetch bridge');
  assert.deepEqual(failures.toggles, [true, false, true, false]);
  assert.equal(failures.networkAborted, true);
  assert.equal(failures.frames, 0);
  const pcm = await page.evaluate(async (asset, b64) => {
    const { decodeYoutubeAudio } = await import(chrome.runtime.getURL(`assets/${asset}`));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const source = await decodeYoutubeAudio(bytes.buffer, 24, new AbortController().signal);
    const samples = source.window(1).audio;
    const result = { sampleRate: source.sampleRate, length: samples.length, start: source.window(5).start,
      nonzero: samples.some((v) => Math.abs(v) > 0.001), peak: samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0) };
    source.close();
    try { source.window(0); result.closed = false; } catch { result.closed = true; }
    return result;
  }, sourceAsset, wav.toString('base64'));
  assert.equal(pcm.sampleRate, 16000); assert.equal(pcm.length, 20 * 16000);
  assert.equal(pcm.start, 5); assert.equal(pcm.nonzero, true); assert.equal(pcm.closed, true);
  assert.ok(Math.abs(pcm.peak - 0.3) < 0.015, 'stereo channels must be averaged into mono');
  console.log('Packaged opaque sandbox, unchanged extension CSP, real YouTube.js fetch, blocked-download cleanup, abort and native CPU audio decoding passed.');
} finally { await browser.close(); }
