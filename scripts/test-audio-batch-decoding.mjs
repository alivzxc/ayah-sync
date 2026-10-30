// Real container/demux/WebCodecs tests without YouTube. FFmpeg creates short
// independent fragments retaining a two-hour timestamp, not two hours of PCM.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = resolve(import.meta.dirname, '../dist');
const asset = readdirSync(resolve(dist, 'assets')).find((f) => /^youtube-source-.*\.js$/.test(f));
const temp = mkdtempSync('/tmp/opencode/audio-batch-test-');
let browser;
try {
  const fixtures = [];
  for (const format of ['mp4', 'webm']) {
    const path = join(temp, `partial.${format}`);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=48000',
      '-ac', '2', '-c:a', format === 'mp4' ? 'aac' : 'libopus', '-b:a', '64k', '-output_ts_offset', '7200',
      ...(format === 'mp4' ? ['-movflags', 'empty_moov+default_base_moof+frag_keyframe'] : []), path]);
    fixtures.push({ format, bytes: readFileSync(path).toString('base64') });
  }
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(target.url()).host}/src/popup/popup.html`);
  const results = await page.evaluate(async ({ asset, fixtures }) => {
    const { openYoutubeBatch, createAudioBatchStore } = await import(chrome.runtime.getURL(`assets/${asset}`));
    const results = [];
    for (const { format, bytes } of fixtures) {
      const blob = new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]);
      const controller = new AbortController();
      const source = await openYoutubeBatch(blob, { start: 7200, end: 7208 }, controller.signal);
      const pcm = await source.read(7201, 7205, controller.signal);
      results.push({ format, length: pcm.length, peak: pcm.reduce((max, x) => Math.max(max, Math.abs(x)), 0),
        nonzero: pcm.filter((x) => Math.abs(x) > 0.001).length });
      controller.abort();
      try { await source.read(7201, 7202, controller.signal); throw Error('aborted read succeeded'); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
      source.close();
      try {
        await openYoutubeBatch(blob, { start: 7200, end: 7300 }, new AbortController().signal);
        throw Error('mismatched duration accepted');
      } catch (e) { if (!e.message.includes('timestamps')) throw e; }
    }
    const root = await navigator.storage.getDirectory();
    const before = [];
    for await (const key of root.keys()) before.push(key);
    const store = await createAudioBatchStore({ diskBytes: 12, memoryBytes: 12 });
    await store.put('a', new Blob(['12345'])); await store.put('b', new Blob(['67890']));
    store.pin('a');
    await store.put('c', new Blob(['abcdef']));
    if (!store.has('a') || store.has('b') || !store.has('c')) throw Error('LRU evicted pinned audio or exceeded its size limit');
    if ((await store.get('a')).size !== 5) throw Error('OPFS blob read failed');
    store.unpin('a'); await store.close();
    const after = [];
    for await (const key of root.keys()) after.push(key);
    if (JSON.stringify(before.sort()) !== JSON.stringify(after.sort())) throw Error('Temporary OPFS directory leaked');
    return results;
  }, { asset, fixtures });
  for (const result of results) {
    assert.equal(result.length, 4 * 16000);
    assert.ok(result.peak > 0.03 && result.peak < 0.3, 'decoded/resampled real audio has a bounded nonzero amplitude');
    assert.ok(result.nonzero > result.length * 0.9);
  }
  console.log('Partial MP4/AAC + WebM/Opus at 2h offsets, bounded PCM, timestamp checks, abort and pinned OPFS LRU cleanup passed.');
} finally { await browser?.close(); rmSync(temp, { recursive: true, force: true }); }
