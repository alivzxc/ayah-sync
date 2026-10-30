// Independent Quran.com word references; no reference text is supplied to ASR.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const cache = resolve(root, 'server/cache/cpu-evaluation');
const corpus = JSON.parse(await readFile(resolve(cache, 'corpus.json')));
const ids = (process.env.CPU_WORD_CASES || '7-1-1,9-67-1').split(',');
const worker = (await readdir(resolve(dist, 'assets'))).find((f) => /^recognition-worker-.*\.js$/.test(f));
const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    if (req.url === '/') { res.end('<!doctype html><title>CPU word benchmark</title>'); return; }
    const url = req.url.split('?')[0];
    const base = url.startsWith('/pcm/') ? cache : url.startsWith('/src/') ? root : dist;
    const file = resolve(base, url.startsWith('/pcm/') ? url.slice(5) : url.slice(1));
    if (!file.startsWith(base + '/')) throw new Error('Invalid path');
    res.setHeader('Content-Type', file.endsWith('.js') || file.endsWith('.mjs') ? 'application/javascript'
      : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    res.end(await readFile(file));
  } catch (error) { res.statusCode = 404; res.end(String(error)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser',
    headless: true, args: ['--disable-gpu'], protocolTimeout: 180000 });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async (worker) => {
    window.bufferClass = (await import('/src/cpu/lookahead-buffer.js')).LookaheadBuffer;
    const w = new Worker(`/assets/${worker}`, { type: 'module' });
    let pending;
    window.ask = (data) => new Promise((resolve, reject) => {
      if (data.type === 'reset') { w.postMessage(data); resolve(); return; }
      pending = { resolve, reject }; w.postMessage(data);
    });
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') return;
      if (data.type === 'error') pending.reject(new Error(data.error));
      else pending.resolve(data);
    };
    w.onerror = (e) => pending.reject(new Error(e.message));
    await window.ask({ type: 'init', baseURL: location.origin + '/', maxThreads: Number(4) });
  }, worker);
  for (const item of corpus.filter((c) => ids.includes(c.id))) {
    const metadata = JSON.parse(await readFile(resolve(cache, `${item.id.split('-').slice(0, 2).join('-')}.json`)));
    const result = await page.evaluate(async ({ item, limit }) => {
      const audio = new Float32Array(await (await fetch(`/pcm/${item.pcm}`)).arrayBuffer());
      await window.ask({ type: 'reset' });
      const buffer = new window.bufferClass(), timing = [], inference = [];
      for (let start = 0; start + 4 <= Math.min(limit, audio.length / 16000); start++) {
        const result = await window.ask({ type: 'audio', generation: 1, freshSeconds: 1, timings: true,
          audioStart: start, alignWords: true, audio: audio.slice(start * 16000, (start + 4) * 16000) });
        buffer.add(start, 4, result, 0);
        const alignment = await window.ask({ type: 'align', cues: buffer.cues.map((c, i) => ({
          match: c.match, t0: c.t0, until: buffer.cues[i + 1]?.t0 ?? buffer.until,
          complete: i + 1 < buffer.cues.length,
        })) });
        buffer.applyAlignments(alignment.alignedWindows);
        timing.push((result.timingMs || 0) + alignment.ms); inference.push(result.ms);
      }
      return { cues: buffer.payload().cues, timing, inference };
    }, { item, limit: Number(process.env.CPU_WORD_SECONDS || 60) });
    const median = (a) => a.sort((a, b) => a - b)[Math.floor(a.length / 2)];
    const score = (field) => {
      const starts = [], ends = [];
      let total = 0;
      for (const verse of metadata.audio_file.timestamps) {
        const cue = result.cues.find((c) => c.match.ref === verse.verse_key);
        if (!cue) continue;
        for (const segment of verse.segments || []) {
          if (segment.length !== 3) continue;
          total++;
          const w = cue[field]?.find((w) => w.word === segment[0] - 1);
          if (!w) continue;
          starts.push(Math.abs(w.start - segment[1] / 1000 / item.rate) * 1000);
          ends.push(Math.abs(w.end - segment[2] / 1000 / item.rate) * 1000);
        }
      }
      const mean = (a) => Math.round(a.reduce((a, b) => a + b, 0) / a.length);
      return { words: starts.length, referenceWords: total, startMAE: mean(starts), endMAE: mean(ends),
        startMedianMs: Math.round(median(starts)), endMedianMs: Math.round(median(ends)) };
    };
    console.log(JSON.stringify({ id: item.id, original: score('words'), aligned: score('highlightWords'),
      timingMedianMs: +median(result.timing).toFixed(3), timingMaxMs: +Math.max(...result.timing).toFixed(3),
      inferenceMedianMs: median(result.inference) }));
    await writeFile(resolve(cache, `words-${item.id}.json`), JSON.stringify({ ...result, metadata }, null, 2));
  }
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
