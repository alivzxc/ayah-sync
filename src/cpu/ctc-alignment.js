import { alignTimedWords } from './lookahead-buffer.js';

// Tiny envelope retained with cached CTC scores, never whole PCM windows.
export function speechEnvelope(audio, sampleRate = 16000) {
  const hop = Math.round(sampleRate * 0.02);
  const energy = new Float32Array(Math.ceil(audio.length / hop));
  let peak = 0;
  for (let frame = 0; frame < energy.length; frame++) {
    let sum = 0;
    const end = Math.min(audio.length, (frame + 1) * hop);
    for (let i = frame * hop; i < end; i++) sum += audio[i] * audio[i];
    energy[frame] = Math.sqrt(sum / (end - frame * hop));
    peak = Math.max(peak, energy[frame]);
  }
  return { energy, step: hop / sampleRate, threshold: Math.max(0.003, peak * 0.01) };
}

const acousticText = (word) => word.replace(/ۦ(?=[ء-ي])/g, 'ي').replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
  .replace(/[آأإٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[^ء-ي]/g, '');

// Viterbi alignment against EXISTING log probabilities. This is display-only:
// it cannot modify the decoded transcript, matcher, or ayah transition times.
export function alignCtcWords(window, ayah, tokens) {
  const { words, logProbs, frames, duration, envelope } = window;
  const anchors = window.range ? [{ word: window.range[0], start: 0, end: 0 },
    { word: window.range[1], start: 0, end: duration }] : alignTimedWords(words, ayah);
  if (anchors.length < Math.min(2, ayah.wordCount)) return [];
  const first = anchors[0], last = anchors.at(-1);
  const canon = ayah.arabic.trim().split(/\s+/);
  const ids = new Map(tokens.map((text, id) => [text, id]));
  const separator = ids.get('▁');
  if (separator == null) return [];
  const labels = [0], wordAt = [-1];
  for (let word = first.word; word <= last.word; word++) {
    const text = acousticText(canon[word]);
    if (!text) continue;
    if (labels.length > 1) { labels.push(separator, 0); wordAt.push(-1, -1); }
    for (const char of text) {
      if (!ids.has(char)) return [];
      labels.push(ids.get(char), 0); wordAt.push(word, -1);
    }
  }
  const step = duration / frames;
  const from = Math.max(0, Math.floor(first.start / step) - 3);
  const nextHeard = window.range ? null : words.find((w) => w.start >= last.end && w.start > last.start);
  const to = Math.min(frames, Math.ceil((nextHeard?.start ?? duration) / step));
  const count = to - from, states = labels.length;
  if (states < 3 || (states - 1) / 2 > count || states > 1025 || count <= 0) return [];
  let previous = new Float64Array(states).fill(-Infinity);
  let current = new Float64Array(states);
  const back = new Uint8Array(count * states);
  previous[0] = logProbs[from * tokens.length];
  previous[1] = logProbs[from * tokens.length + labels[1]];
  for (let frame = 1; frame < count; frame++) {
    current.fill(-Infinity);
    for (let state = 0; state < states; state++) {
      let best = previous[state], move = 0;
      if (state && previous[state - 1] > best) { best = previous[state - 1]; move = 1; }
      if (state > 1 && labels[state] && labels[state] !== labels[state - 2] && previous[state - 2] > best) {
        best = previous[state - 2]; move = 2;
      }
      current[state] = best + logProbs[(from + frame) * tokens.length + labels[state]];
      back[frame * states + state] = move;
    }
    [previous, current] = [current, previous];
  }
  let state = previous[states - 1] > previous[states - 2] ? states - 1 : states - 2;
  if (!Number.isFinite(previous[state])) return [];
  const path = new Uint16Array(count);
  for (let frame = count - 1; frame >= 0; frame--) {
    path[frame] = state;
    if (frame) state -= back[frame * states + state];
  }
  const spans = new Map();
  for (let frame = 0; frame < count; frame++) {
    const state = path[frame], word = wordAt[state];
    if (word < 0) continue;
    const span = spans.get(word) || { word, start: (from + frame) * step, end: 0, score: 0, count: 0 };
    span.end = (from + frame + 1) * step;
    span.score += logProbs[(from + frame) * tokens.length + labels[state]];
    span.count++;
    spans.set(word, span);
  }
  const result = [...spans.values()];
  for (let i = 0; i < result.length; i++) {
    const span = result[i];
    span.confidence = Math.exp(span.score / span.count);
    if (!envelope) continue;
    const { energy, step: hop, threshold } = envelope;
    // CTC letters are spikes. Follow a sustained vowel through voiced frames,
    // but stop at a real quiet gap instead of stretching across a breath.
    const limit = result[i + 1]?.start ?? nextHeard?.start ?? duration;
    let quiet = 0;
    for (let k = Math.floor(span.end / hop); k < energy.length && k * hop < limit; k++) {
      if (energy[k] >= threshold) { span.end = Math.min(limit, (k + 1) * hop); quiet = 0; }
      else if (++quiet >= 8) break;
    }
  }
  return result.filter((w) => w.confidence >= 0.2 && w.end > w.start)
    .map(({ word, start, end, confidence }) => ({ word, start, end, confidence }));
}

// Stitch the central (least edge-affected) CTC frames from overlapping windows.
// This gives long vowels a complete acoustic context without re-running ASR.
export function stitchCtcWindows(windows, cue, vocabularySize) {
  if (!windows.length) return null;
  const start = Math.max(windows[0].start, cue.t0 - 0.3);
  const end = Math.min(windows.at(-1).start + windows.at(-1).duration, cue.until);
  if (!(end > start)) return null;
  const step = 0.04;
  const frames = Math.ceil((end - start) / step);
  const logProbs = new Float32Array(frames * vocabularySize);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const at = Math.min(end - 0.001, start + (frame + 0.5) * step);
    let best = null, distance = Infinity;
    for (const window of windows) {
      if (at < window.start || at >= window.start + window.duration) continue;
      const d = Math.abs(at - window.start - window.duration / 2);
      if (d < distance) { best = window; distance = d; }
    }
    if (!best) return null;
    const index = Math.min(best.frames - 1, Math.floor((at - best.start) / best.duration * best.frames));
    logProbs.set(best.logProbs.subarray(index * vocabularySize, (index + 1) * vocabularySize), frame * vocabularySize);
    const e = best.envelope;
    energy[frame] = e.energy[Math.min(e.energy.length - 1, Math.floor((at - best.start) / e.step))] >= e.threshold ? 1 : 0;
  }
  const words = windows.flatMap((window) => window.words.filter((w) =>
    w.start >= 1 && w.start < 3 && window.start + w.start >= start && window.start + w.start < end)
    .map((w) => ({ ...w, start: w.start + window.start - start, end: Math.min(end, w.end + window.start) - start })))
    .sort((a, b) => a.start - b.start);
  const anchors = alignTimedWords(words, cue.match);
  if (anchors.length < Math.min(2, cue.match.wordCount)) return null;
  return { start, duration: frames * step, frames, logProbs, words,
    range: cue.complete ? [anchors[0].word, cue.match.wordCount - 1] : [anchors[0].word, anchors.at(-1).word],
    envelope: { energy, step, threshold: 0.5 } };
}
