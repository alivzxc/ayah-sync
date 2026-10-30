// Offline replay of real audio through the browser WASM model. Each simulated
// request completes after its MEASURED inference time, so scoring includes lag.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'server/cache/cpu-evaluation');
const corpus = JSON.parse(await readFile(resolve(dir, 'corpus.json'), 'utf8'));
const limit = Number(process.env.CPU_BENCH_SECONDS || 90);
const maxThreads = Number(process.env.CPU_BENCH_THREADS || 1);
const trackingWindow = Number(process.env.CPU_BENCH_WINDOW || 4);
const methods = (process.env.CPU_BENCH_METHODS || 'fixed').split(',');
const selected = process.env.CPU_BENCH_CASES ? corpus.filter((c) => process.env.CPU_BENCH_CASES.split(',').includes(c.id)) : corpus;
const dist = resolve(root, 'dist');
const workerFile = (await readdir(resolve(dist, 'assets'))).find((f) => /^recognition-worker-.*\.js$/.test(f));
const server = createServer(async (req, res) => {
  if (maxThreads > 1) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  if (process.env.CPU_BENCH_DEBUG) console.log('GET', req.url);
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>CPU benchmark</title>'); return; }
    const path = req.url.split('?')[0];
    const file = path.startsWith('/pcm/') ? resolve(dir, path.slice(5)) : resolve(dist, path.slice(1));
    if (!file.startsWith(dist + '/') && !file.startsWith(dir + '/')) throw new Error('Invalid path');
    const types = { js: 'application/javascript', mjs: 'application/javascript', wasm: 'application/wasm', json: 'application/json' };
    res.setHeader('Content-Type', types[file.split('.').at(-1)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch (error) { if (process.env.CPU_BENCH_DEBUG) console.log('404', req.url); res.statusCode = 404; res.end(String(error)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
const results = [];
try {
  browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
    args: ['--disable-gpu'], protocolTimeout: 600000 });
  const page = await browser.newPage();
  if (process.env.CPU_BENCH_DEBUG) page.on('console', (m) => console.log('browser', m.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const client = await page.createCDPSession();
  const throttle = Number(process.env.CPU_BENCH_THROTTLE || 1);
  if (throttle > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const actualThreads = await page.evaluate(async ({ workerFile, maxThreads }) => {
    const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
    let resolveResult, rejectResult;
    const request = (data) => new Promise((resolve, reject) => {
      resolveResult = resolve; rejectResult = reject;
      worker.postMessage(data);
    });
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready' || data.type === 'result') resolveResult(data);
      else if (data.type === 'error') rejectResult(new Error(data.error));
    };
    worker.onerror = (e) => rejectResult(new Error(e.message));
    const ready = await request({ type: 'init', baseURL: location.origin + '/', maxThreads });
    window.recognizer = {
      reset() { worker.postMessage({ type: 'reset' }); },
      recognize(audio, freshSeconds) { return request({ type: 'audio', audio, generation: 1, freshSeconds }); },
    };
    return ready.threads;
  }, { workerFile, maxThreads });
  // Load scheduling utilities as data; the model itself is the production bundle.
  const schedulerSource = await readFile(resolve(root, 'src/cpu/recognition-scheduler.js'), 'utf8');
  const audioSource = await readFile(resolve(root, 'src/cpu/audio-window.js'), 'utf8');
  const pacingSource = await readFile(resolve(root, 'src/cpu/live-pacing.js'), 'utf8');
  await page.evaluate((source) => { window.utilities = new Function(source.replaceAll('export ', '') +
    '; return { RecognitionScheduler, AudioWindow, recognitionCooldown };')(); }, schedulerSource + '\n' + audioSource + '\n' + pacingSource);
  for (const item of selected) for (const method of methods) {
    const result = await page.evaluate(async ({ item, method, limit, trackingWindow, actualThreads }) => {
      const { RecognitionScheduler, AudioWindow, recognitionCooldown } = window.utilities;
      const pcm = new Float32Array(await (await fetch(`/pcm/${item.pcm}`)).arrayBuffer());
      const sr = 16000;
      const scheduler = new RecognitionScheduler(sr);
      const audio = new AudioWindow(sr * 10);
      window.recognizer.reset();
      let blockedUntil = 0, pending = null, displayed = null, locked = false;
      const calls = [], emissions = [], scores = { correct: 0, wrong: 0, blank: 0, total: 0 };
      const seconds = Math.min(limit, pcm.length / sr);
      for (let offset = 0; offset < seconds * sr; offset += sr / 10) {
        const at = (offset + sr / 10) / sr;
        const frame = pcm.subarray(offset, offset + sr / 10);
        audio.push(frame); scheduler.push(frame);
        if (pending && at >= pending.at) {
          if (pending.match) {
            displayed = pending.match.ref;
            emissions.push({ at, ref: displayed });
          }
          pending = null;
        }
        const expected = item.references.find((r) => r.start <= at && at < r.end);
        if (expected) {
          scores.total++;
          if (displayed === expected.ref) scores.correct++;
          else if (displayed) scores.wrong++;
          else scores.blank++;
        }
        if (at < blockedUntil || pending) continue;
        const reason = scheduler.due();
        if (!reason) continue;
        const clip = audio.snapshot(locked ? trackingWindow * sr : scheduler.windowSamples());
        const freshSeconds = scheduler.freshSeconds();
        scheduler.submittedNow();
        const output = await window.recognizer.recognize(clip, freshSeconds);
        locked = output.tracking?.locked || false;
        scheduler.updateTracking(output.tracking, output.ms, actualThreads);
        pending = { ...output, at: at + output.ms / 1000 };
        blockedUntil = pending.at + recognitionCooldown(output.ms, scheduler.responsive) / 1000;
        calls.push({ at, reason, audioSeconds: clip.length / sr, text: output.text,
          ref: output.match?.ref || null, ms: output.ms });
      }
      const transitions = item.references.filter((r) => r.start > 0 && r.start < seconds - 8).map((r) => {
        const found = emissions.find((e) => e.at >= r.start && e.at < r.end && e.ref === r.ref);
        return { ref: r.ref, start: r.start, delay: found ? found.at - r.start : null };
      });
      return { id: item.id, method, testedSeconds: seconds, scores, calls, emissions, transitions };
    }, { item, method, limit, trackingWindow, actualThreads });
    const ms = result.calls.map((c) => c.ms).sort((a, b) => a - b);
    result.summary = { accuracy: result.scores.total ? +(result.scores.correct / result.scores.total * 100).toFixed(1) : null,
      wrong: result.scores.total ? +(result.scores.wrong / result.scores.total * 100).toFixed(1) : null,
      calls: result.calls.length, inferenceP50Ms: ms[Math.floor(ms.length / 2)],
      inferenceTotalSeconds: +(ms.reduce((a, b) => a + b, 0) / 1000).toFixed(2),
      transitionsFound: result.transitions.filter((t) => t.delay !== null).length, transitionsTotal: result.transitions.length };
    console.log(JSON.stringify({ id: item.id, reciter: item.reciter, method, ...result.summary }));
    results.push(result);
    await writeFile(resolve(dir, `results-${process.env.CPU_BENCH_TAG || 'latest'}.json`), JSON.stringify({
      environment: { cpu: cpus()[0]?.model, logicalCPUs: cpus().length, threads: actualThreads, throttle, browser: await browser.version(),
        note: 'WASM replay, not physical average-CPU hardware; videos without independent references are unscored' },
      corpus: selected, results,
    }, null, 2));
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
