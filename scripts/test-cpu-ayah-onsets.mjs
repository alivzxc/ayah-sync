// Independent published first-word timings, with real audio through the CPU
// worker. Compare onset-corrected cues with the exact same raw CTC evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const dir = resolve(root, 'server/cache/cpu-evaluation');
const corpus = JSON.parse(await readFile(resolve(dir, 'corpus.json'), 'utf8'));
const ids = (process.env.CPU_ONSET_CASES || '7-1-1,9-67-1,3-78-1,6-93-1').split(',');
const cases = await Promise.all(corpus.filter((c) => ids.includes(c.id)).map(async (c) => {
  const metadata = JSON.parse(await readFile(resolve(dir, `${c.id.split('-').slice(0, 2).join('-')}.json`), 'utf8'));
  return { ...c, wordReferences: metadata.audio_file.timestamps.flatMap((v) => {
    const word = v.segments.find((s) => s[0] === 1 && s.length === 3);
    return word ? [{ ref: v.verse_key, start: word[1] / 1000 / c.rate, end: word[2] / 1000 / c.rate }] : [];
  }) };
}));
const workerFile = (await readdir(resolve(dist, 'assets'))).find((f) => /^recognition-worker-.*\.js$/.test(f));
const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>CPU ayah onset replay</title>'); return; }
    const base = path.startsWith('/pcm/') ? dir : path.startsWith('/src/cpu/') ? root : dist;
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
    args: ['--disable-gpu'], protocolTimeout: 180000 });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async ({ workerFile, cases, trace }) => {
    const { LookaheadBuffer } = await import('/src/cpu/lookahead-buffer.js');
    const worker = new Worker('/assets/' + workerFile, { type: 'module' });
    let yes, no;
    const ask = (data) => new Promise((resolve, reject) => { yes = resolve; no = reject; worker.postMessage(data); });
    worker.onmessage = ({ data }) => { if (data.type === 'error') no(Error(data.error)); else if (data.type !== 'progress') yes(data); };
    worker.onerror = (e) => no(Error(e.message));
    await ask({ type: 'init', baseURL: location.origin + '/', maxThreads: 4 });
    const output = [];
    for (const item of cases) {
      worker.postMessage({ type: 'reset' });
      const pcm = new Float32Array(await (await fetch('/pcm/' + item.pcm)).arrayBuffer());
      const buffer = new LookaheadBuffer(), original = new LookaheadBuffer(), observations = [];
      for (let start = 0; start + 4 <= Math.min(60, pcm.length / 16000); start++) {
        const result = await ask({ type: 'audio', audio: pcm.slice(start * 16000, (start + 4) * 16000),
          generation: 1, freshSeconds: 1, timings: true, audioStart: start, alignWords: false });
        if (item.id === trace && start >= 20 && start <= 33) observations.push({ start, text: result.text,
          accepted: result.match?.ref, timing: result.timingMatches?.map((m) => ({ ref: m.match.ref, spans: m.spans })) });
        buffer.add(start, 4, result, 0);
        original.add(start, 4, { ...result, timingMatches: result.timingMatches?.filter((m) => !m.recoveredPrefix).map((m) => ({ ...m,
          spans: m.spans.map((w) => ({ ...w, start: w.rawStart ?? w.start })) })) }, 0);
      }
      output.push({ id: item.id, ...(observations.length ? { observations } : {}),
        refs: buffer.cues.map((c) => c.match.ref), originalRefs: original.cues.map((c) => c.match.ref),
        rows: item.wordReferences.flatMap((ref) => {
          const cue = buffer.cues.find((c) => c.match.ref === ref.ref), raw = original.cues.find((c) => c.match.ref === ref.ref);
          return cue?.words.some((w) => w.word === 0) && raw ? [{ ...ref, before: raw.t0, after: cue.t0,
            beforeMs: Math.round((raw.t0 - ref.start) * 1000), afterMs: Math.round((cue.t0 - ref.start) * 1000) }] : [];
        }) });
    }
    worker.terminate(); return output;
  }, { workerFile, cases, trace: process.env.CPU_ONSET_TRACE });
  const rows = results.flatMap((r) => r.rows);
  const summary = (field) => ({ count: rows.length,
    meanAbsoluteMs: Math.round(rows.reduce((sum, r) => sum + Math.abs(r[field]), 0) / rows.length),
    meanSignedMs: Math.round(rows.reduce((sum, r) => sum + r[field], 0) / rows.length),
    lateOver300ms: rows.filter((r) => r[field] > 300).length, earlyOver300ms: rows.filter((r) => r[field] < -300).length });
  const report = { before: summary('beforeMs'), after: summary('afterMs'), cases: results };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CPU_ONSET_REPORT) await writeFile(process.env.CPU_ONSET_REPORT, JSON.stringify(report, null, 2));
  assert.ok(rows.length >= Math.min(10, cases.length * 3), 'real-audio onset scoring must have enough independently referenced cues');
  for (const item of results) assert.deepEqual(item.refs, item.originalRefs, 'onset refinement must not add or drop ayahs');
  if (!process.env.CPU_ONSET_CASES) {
    assert.ok(report.after.meanAbsoluteMs < report.before.meanAbsoluteMs * 0.6, 'onset/prefix refinement should substantially reduce measured transition error');
    assert.ok(report.after.earlyOver300ms <= report.before.earlyOver300ms, 'do not trade late transitions for large premature transitions');
    const longFirstWord = results.find((r) => r.id === '6-93-1').rows.find((r) => r.ref === '93:5');
    assert.ok(longFirstWord.before > 27 && longFirstWord.after < 25 && Math.abs(longFirstWord.afterMs) < 250,
      '93:5 must start at its previously recognized first word, not the later confirming words');
  }
  console.log('Real-audio CPU ayah-onset accuracy, delayed first-word recovery and unchanged verse sequence passed.');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
