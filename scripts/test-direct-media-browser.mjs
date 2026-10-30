// Generated ordinary HTTP files + the packaged extension, no Python/YouTube.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { Input, BufferSource, MATROSKA } from 'mediabunny';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const asset = readdirSync(resolve(dist, 'assets')).find((f) => /^direct-media-source-.*\.js$/.test(f));
assert.ok(asset, 'Build the extension first');
const temp = mkdtempSync('/tmp/opencode/direct-media-test-'), files = new Map(), requests = [];
let browser, server;
try {
  for (const [name, args, mime] of [
    ['long.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2000:sample_rate=16000', '-c:a', 'libmp3lame', '-b:a', '24k'], 'audio/mpeg'],
    ['long.mp4', ['-f', 'lavfi', '-i', 'color=black:s=16x16:r=1:d=2000', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2000:sample_rate=16000',
      '-c:v', 'mpeg4', '-g', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', '-shortest', '-movflags', '+faststart'], 'video/mp4'],
    ['short.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=8000', '-ac', '2', '-c:a', 'pcm_s16le'], 'audio/wav'],
    ['short.webm', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=48000', '-c:a', 'libopus'], 'audio/webm'],
  ]) {
    const path = join(temp, name);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...args, path]);
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]));
    files.set('/' + name, { bytes: readFileSync(path), mime, duration });
  }
  const recitation = resolve(root, 'server/cache/gt_7_1.mp3');
  if (existsSync(recitation)) files.set('/recitation.mp3', { bytes: readFileSync(recitation), mime: 'audio/mpeg' });
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const file = files.get(url.pathname);
    if (file) {
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const from = match ? Number(match[1]) : 0, until = match?.[2] ? Math.min(Number(match[2]), file.bytes.length - 1) : file.bytes.length - 1;
      if (from > until) { res.writeHead(416).end(); return; }
      requests.push({ path: url.pathname, from, until, ranged: !!match });
      res.writeHead(match ? 206 : 200, { 'Content-Type': file.mime, 'Content-Length': until - from + 1,
        'Accept-Ranges': 'bytes', ETag: '"fixture-1"', ...(match ? { 'Content-Range': `bytes ${from}-${until}/${file.bytes.length}` } : {}) });
      res.end(file.bytes.subarray(from, until + 1));
    } else if (url.pathname === '/no-range') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(new Uint8Array(8192));
    } else {
      const tag = url.searchParams.get('tag') === 'audio' ? 'audio' : 'video';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>Standard ${tag} CPU test</title><${tag} controls preload="metadata" src="/recitation.mp3" style="width:640px;height:300px"></${tag}>`);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    protocolTimeout: 360000, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'] });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker(), extension = `chrome-extension://${new URL(target.url()).host}`;
  const observer = await browser.newPage();
  await observer.goto(`${extension}/src/popup/popup.html`);
  for (const name of ['long.mp3', 'long.mp4', 'short.wav', 'short.webm']) {
    const fixture = files.get('/' + name), initialRequests = requests.length;
    const result = await observer.evaluate(async ({ asset, url, duration }) => {
      const { prepareDirectMedia } = await import(chrome.runtime.getURL(`assets/${asset}`));
      globalThis.mediaAbort = new AbortController(); globalThis.mediaProgress = [];
      globalThis.directSource = await prepareDirectMedia({ url, expectedDuration: duration, position: duration > 180 ? 22 : 5,
        signal: mediaAbort.signal, onProgress(p) { if (['ready', 'failed'].includes(p.stage)) mediaProgress.push(p); } });
      const pcm = await directSource.window(duration > 180 ? 22 : 1);
      const blob = await directSource.store.get(directSource.records[0].id);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { initial: directSource.plan.initial, length: pcm.audio.length, nonzero: pcm.audio.some((x) => Math.abs(x) > 0.001), bytes: btoa(binary) };
    }, { asset, url: `${origin}/${name}?token=not-for-logs`, duration: fixture.duration });
    assert.equal(result.initial.start, fixture.duration > 180 ? 12 : 0);
    assert.equal(result.initial.end - result.initial.start, Math.min(180, fixture.duration));
    assert.equal(result.length, Math.round(Math.min(20, fixture.duration - (fixture.duration > 180 ? 22 : 1)) * 16000));
    assert.equal(result.nonzero, true);
    if (fixture.duration > 180) {
      const reads = requests.slice(initialRequests).filter((r) => r.path === '/' + name);
      const nextProbe = reads.findIndex((r, i) => i > 0 && r.from === 0 && r.until === 0);
      const initialBytes = reads.slice(0, nextProbe < 0 ? reads.length : nextProbe).reduce((sum, r) => sum + r.until - r.from + 1, 0);
      assert.ok(initialBytes < fixture.bytes.length / 2, 'startup must not scan/download the entire long file');
    }
    const batch = new Input({ source: new BufferSource(new Uint8Array(Buffer.from(result.bytes, 'base64'))), formats: [MATROSKA] });
    assert.deepEqual((await batch.getTracks()).map((t) => t.type), ['audio'], 'even a video file must produce an audio-only cache batch');
    assert.ok(await batch.computeDuration() < 181, 'initial cache contains only three minutes, not a whole long video');
    batch.dispose();
    if (fixture.duration > 180) {
      await observer.waitForFunction(() => mediaProgress.some((p) => p.phase === 'background'), { timeout: 330000, polling: 100 });
      const progress = await observer.evaluate(() => mediaProgress.find((p) => p.phase === 'background'));
      assert.equal(progress.stage, 'ready', `${name}: 30-minute background batch must be cached`);
      assert.equal(progress.end - progress.start, 1800);
      const crossing = await observer.evaluate(async (start) => {
        const data = await directSource.window(start - 2);
        return { length: data.audio.length, nonzero: data.audio.some((x) => Math.abs(x) > 0.001) };
      }, progress.start);
      assert.equal(crossing.length, 20 * 16000); assert.equal(crossing.nonzero, true);
    }
    await observer.evaluate(async () => { mediaAbort.abort(); await directSource.close(); });
    assert.ok(requests.slice(initialRequests).every((r) => r.ranged && r.until - r.from + 1 <= 512 * 1024), 'never fetch the media file unbounded');
    console.log(name, ': real range download, audio-only remux, native decoding, startup/boundary and cleanup passed.');
  }
  const failure = await observer.evaluate(async ({ asset, url }) => {
    const { prepareDirectMedia } = await import(chrome.runtime.getURL(`assets/${asset}`));
    try { await prepareDirectMedia({ url, expectedDuration: 2000, signal: new AbortController().signal }); }
    catch (e) { return e.message; }
  }, { asset, url: origin + '/no-range?token=do-not-log' });
  assert.match(failure, /unavailable/); assert.doesNotMatch(failure, /token=|127\.0\.0/);

  // Full extension route and CPU WASM recognition on actual recitation, without
  // the optional helper. Generated-file range tests above do not require it.
  if (files.has('/recitation.mp3')) {
    await sw.evaluate(() => {
      const original = fetch;
      globalThis.fetch = (url, init) => String(url).includes(':8790/health') ? Promise.reject(Error('Helper disabled')) : original(url, init);
      return chrome.storage.local.set({ qltRecognition: 'browser', qltCPULookahead: true, qltCPUHighlight: false });
    });
    for (const tag of ['audio', 'video']) {
      const page = await browser.newPage();
      await page.goto(`${origin}/?tag=${tag}`);
      await page.waitForFunction(() => document.querySelector('audio, video').duration > 0);
      await page.$eval('audio, video', (v) => { v.pause(); v.currentTime = 22; });
      await page.waitForFunction(() => !document.querySelector('audio, video').seeking);
      await page.bringToFront();
      await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }));
      await observer.waitForFunction(async () => {
        const { qltState: s } = await chrome.storage.session.get('qltState');
        return s?.status === 'error' || s?.backend === 'browser' || s?.buffered?.ready;
      }, { timeout: 120000, polling: 250 });
      const state = await observer.evaluate(async () => (await chrome.storage.session.get('qltState')).qltState);
      assert.equal(state.error, null); assert.equal(state.cpuAudioSource, 'direct'); assert.equal(state.backend, 'lookahead');
      await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot.querySelector('#where').textContent.includes('1:5'));
      await page.$eval('audio, video', (v) => { v.currentTime = 30; });
      await page.waitForFunction(() => document.querySelector('#__qlt_card_host__')?.shadowRoot.querySelector('#where').textContent.includes('1:6'));
      await observer.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
      await observer.waitForFunction(async () => !(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length,
        { timeout: 15000, polling: 100 });
      await page.close();
      console.log(`Standard <${tag}>: browser-only CPU recognition, timed card and seek passed (helper disabled).`);
    }
  } else console.log('Cached recitation missing: skipped optional full ASR route, generated-file browser tests passed.');
  assert.deepEqual(await observer.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), files = [];
    for await (const name of root.keys()) if (name.startsWith('cpu-audio-')) files.push(name);
    return files;
  }), [], 'Stop/failure must remove all private direct-media cache directories');
  assert.deepEqual(await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), [], 'direct media must never enable YouTube header rules');
} finally {
  await browser?.close(); server?.closeAllConnections(); server?.close(); rmSync(temp, { recursive: true, force: true });
}
