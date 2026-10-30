// Opt-in integration replay. Requires the cached evaluation corpus + a build;
// uses the production WASM worker and timing buffer, not synthetic transcripts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const corpusDir = resolve(root, 'server/cache/cpu-evaluation');
const corpus = JSON.parse(await readFile(resolve(corpusDir, 'corpus.json'), 'utf8'));
const cases = corpus.filter((c) => ['3-78-1', '6-93-1'].includes(c.id));
assert.equal(cases.length, 2, 'both short-ayah real-audio fixtures are required');
const workerFile = (await readdir(resolve(dist, 'assets'))).find((f) => /^recognition-worker-.*\.js$/.test(f));
const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>CPU short-ayah replay</title>'); return; }
    const base = path.startsWith('/pcm/') ? corpusDir : path.startsWith('/src/cpu/') ? root : dist;
    const file = resolve(base, path.startsWith('/pcm/') ? path.slice(5) : path.slice(1));
    if (!file.startsWith(base + '/')) throw Error('Outside test root');
    res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'application/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('Missing test asset'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    args: ['--disable-gpu'], protocolTimeout: 120000 });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async ({ workerFile, cases }) => {
    const { LookaheadBuffer } = await import('/src/cpu/lookahead-buffer.js');
    const worker = new Worker('/assets/' + workerFile, { type: 'module' });
    let yes, no;
    const ask = (data) => new Promise((resolve, reject) => { yes = resolve; no = reject; worker.postMessage(data); });
    worker.onmessage = ({ data }) => { if (data.type === 'error') no(Error(data.error)); else if (data.type !== 'progress') yes(data); };
    worker.onerror = (e) => no(Error(e.message));
    const { threads } = await ask({ type: 'init', baseURL: location.origin + '/', maxThreads: 4 });
    const output = [];
    for (const item of cases) {
      worker.postMessage({ type: 'reset' });
      const pcm = new Float32Array(await (await fetch('/pcm/' + item.pcm)).arrayBuffer());
      const buffer = new LookaheadBuffer({ retainCues: true });
      for (let start = 0; start + 4 <= Math.min(32, pcm.length / 16000); start++) {
        const result = await ask({ type: 'audio', audio: pcm.slice(start * 16000, (start + 4) * 16000),
          generation: 1, freshSeconds: 1, timings: true, audioStart: start, alignWords: false });
        buffer.add(start, 4, result, 0);
      }
      const expected = item.references.filter((r) => r.end <= 28).map((r) => r.ref);
      const found = new Set(buffer.cues.map((c) => c.match.ref));
      output.push({ id: item.id, threads, cues: buffer.cues.map((c) => ({ ref: c.match.ref, at: +c.t0.toFixed(2) })),
        missing: expected.filter((ref) => !found.has(ref)) });
    }
    worker.terminate();
    return output;
  }, { workerFile, cases });
  console.log(JSON.stringify(results, null, 2));
  const naba = results.find((r) => r.id === '3-78-1');
  assert.ok(naba.cues.some((c) => c.ref === '78:4' && c.at >= 9.5 && c.at <= 10.7), '78:4 must not be delayed to the repeated phrase in 78:5');
  assert.ok(naba.cues.some((c) => c.ref === '78:5'), 'stale word ends must not remove 78:5');
  const duha = results.find((r) => r.id === '6-93-1');
  assert.deepEqual(duha.cues.slice(0, 3).map((c) => c.ref), ['93:1', '93:2', '93:3'], 'confirmed context must recover the short startup ayahs');
  console.log('Real-audio WASM short-startup and overlapping-ayah timing regressions passed.');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
