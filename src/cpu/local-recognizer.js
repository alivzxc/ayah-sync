import * as ort from 'onnxruntime-web';
import { computeFbank, normalizeAudio } from './audio-features.js';
import { decodeCtc, wordHighlight } from './ctc-words.js';
import { alignCtcWords, speechEnvelope, stitchCtcWindows } from './ctc-alignment.js';
import { QuranMatcher } from './match.js';
import { PassageTracker } from './passage-tracker.js';
import { passageTimings } from './passage-timings.js';
import arabic from '../data/quran-uthmani.json';
import english from '../data/quran-en.json';
import surahs from '../data/surahs.json';
import indopak from '../data/quran-indopak.json';

// CPU ONLY: browser WASM inference. The original Python GPU engine/alignment
// remains in server/engine.py and server/align.py and never uses this module.
const MEL_BINS = 80;

export async function createRecognizer(baseURL, progress = () => {}, maxThreads = 4) {
  ort.env.wasm.wasmPaths = new URL('ort/', baseURL).href;
  const threads = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
    ? Math.min(maxThreads, Math.max(1, navigator.hardwareConcurrency || 1))
    : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  const modelUrl = new URL('models/quran-asr-small/model.int8.onnx', baseURL);
  progress({ status: 'progress', file: modelUrl.href, progress: 0 });
  const [modelResponse, tokenResponse] = await Promise.all([
    fetch(modelUrl), fetch(new URL('models/quran-asr-small/tokens.txt', baseURL)),
  ]);
  if (!modelResponse.ok || !tokenResponse.ok) throw new Error('CPU model files are missing. Run scripts/export-browser-model.py and rebuild.');
  const [model, tokenText] = await Promise.all([modelResponse.arrayBuffer(), tokenResponse.text()]);
  const tokens = [];
  for (const line of tokenText.trim().split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\d+)$/);
    if (match) tokens[Number(match[2])] = match[1];
  }
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  progress({ status: 'progress', file: modelUrl.href, progress: 100 });
  const matcher = new QuranMatcher(arabic, english, surahs, indopak);
  const tracker = new PassageTracker(matcher);
  let epoch = 0;
  let timingCache = [];
  const timingMemo = new Map();
  const refine = (windows, cues) => cues.flatMap((cue) => {
    const key = `${cue.match.ref}:${cue.t0}:${cue.until}`;
    if (timingMemo.has(key)) return timingMemo.get(key);
    const window = stitchCtcWindows(windows, cue, tokens.length);
    if (!window) return [];
    const spans = alignCtcWords(window, cue.match, tokens).filter((w) =>
      window.start + w.start >= (cue.t0 ?? -Infinity) - 0.2 &&
      window.start + w.start < (cue.until ?? Infinity));
    const result = spans.length ? [{ ref: cue.match.ref, start: window.start, duration: window.duration, spans }] : [];
    if (cue.complete && windows.at(-1).start >= cue.until - 1) {
      timingMemo.set(key, result);
      if (timingMemo.size > 32) timingMemo.delete(timingMemo.keys().next().value);
    }
    return result;
  });
  return {
    threads,
    reset(keepContext = false) { tracker.reset(keepContext); epoch++; timingCache = []; timingMemo.clear(); },
    refineTimings(cues) { return refine(timingCache, cues); },
    async recognize(audio, freshSeconds = 0.5, timings = false, options = {}) {
      const passage = tracker;
      const startedEpoch = epoch;
      const start = performance.now();
      let peak = 0;
      for (const value of audio) peak = Math.max(peak, Math.abs(value));
      if (peak < 0.005) return { match: null, text: '', ms: 0, tracking: passage.state(), highlight: null };
      const normalized = normalizeAudio(audio, peak);
      const fbank = computeFbank(normalized);
      const result = await session.run({
        x: new ort.Tensor('float32', fbank.data, [1, fbank.frames, MEL_BINS]),
        x_lens: new ort.Tensor('int64', BigInt64Array.of(BigInt(fbank.frames)), [1]),
      });
      const outputFrames = Number(result.log_probs_len.data[0]);
      const duration = audio.length / 16000;
      const { text, words } = decodeCtc(result.log_probs.data, outputFrames, tokens, duration);
      if (startedEpoch !== epoch) {
        return { match: null, text: '', ms: Math.round(performance.now() - start) };
      }
      // Faster overlapping observations are correlated. Do not let them erase
      // passage context twice as quickly as the normal half-second cadence.
      const envelope = timings ? speechEnvelope(normalized) : null;
      const match = passage.update(text, Math.min(1, Math.max(0, freshSeconds) / 0.5),
        timings ? { start: options.audioStart || 0, words, envelope } : null);
      const highlight = wordHighlight(words, passage.current, duration);
      const timingStart = performance.now();
      if (timings) {
        const window = { start: options.audioStart || 0, words, duration, frames: outputFrames,
          logProbs: result.log_probs.data.slice(), envelope };
        timingCache.push(window);
        if (timingCache.length > 24) timingCache.shift();
      }
      return { match, text, highlight, ms: Math.round(performance.now() - start), tracking: passage.state(),
        ...(timings ? { timedWords: words, timingMatch: passage.locked ? passage.current : null,
          newPassage: passage.newPassage,
          timingMatches: passageTimings(passage.timingMatches),
          timingMs: performance.now() - timingStart } : {}) };
    },
  };
}
