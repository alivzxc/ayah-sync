import { normalizeArabic } from './match.js';

export function alignTimedWords(words, ayah) {
  const canon = ayah.arabic.trim().split(/\s+/).map(normalizeArabic);
  const heard = words.map((w) => normalizeArabic(w.text));
  const rows = Array.from({ length: heard.length + 1 }, () => new Uint16Array(canon.length + 1));
  for (let i = 1; i <= heard.length; i++) {
    for (let j = 1; j <= canon.length; j++) {
      rows[i][j] = heard[i - 1] && heard[i - 1] === canon[j - 1] ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const pairs = [];
  let i = heard.length, j = canon.length;
  while (i && j) {
    if (heard[i - 1] && heard[i - 1] === canon[j - 1]) {
      pairs.push({ word: j - 1, start: words[i - 1].start, end: words[i - 1].end });
      i--; j--;
    } else if (rows[i - 1][j] > rows[i][j - 1]) i--;
    else j--;
  }
  return pairs.reverse();
}

// Timing buffer, not a whole-video recognition job. Only verses
// supported by a confirmed passage are eligible for timed display.
export class LookaheadBuffer {
  constructor({ retainCues = false } = {}) { this.retainCues = retainCues; this.reset(); }
  reset() {
    this.cues = []; this.history = []; this.from = this.until = null;
    this.observations = new WeakMap(); this.observationFloor = 0;
  }
  indexAt(time) {
    let lo = 0, hi = this.cues.length - 1, index = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].t0 <= time) { index = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return index;
  }
  applyAlignments(windows) {
    const updated = new Set([this.cues.length - 2, this.cues.length - 1]);
    for (const window of windows || []) {
      for (let i = Math.max(0, this.indexAt(window.start));
           i < this.cues.length && this.cues[i].t0 < window.start + window.duration; i++) {
        const cue = this.cues[i];
        if (cue.match.ref !== window.ref || window.start + window.duration <= cue.t0 ||
            window.start >= (this.cues[i + 1]?.t0 ?? this.until)) continue;
        let observations = this.observations.get(cue);
        if (!observations) { observations = new Map(); this.observations.set(cue, observations); }
        for (const span of window.spans) {
          const start = window.start + span.start, end = window.start + span.end;
          if (start < cue.t0 - 0.2 || end <= start) continue;
          const samples = observations.get(span.word) || new Map();
          samples.set(window.start, { start, end, confidence: span.confidence,
            quality: span.confidence * (0.25 + Math.min(0.75, Math.max(0, Math.min(span.start, window.duration - span.end)))) });
          if (samples.size > 24) samples.delete(samples.keys().next().value);
          observations.set(span.word, samples);
        }
        const median = (values) => {
          values.sort((a, b) => a - b);
          const i = Math.floor(values.length / 2);
          return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
        };
        const words = [...observations].map(([word, samples]) => {
          const values = [...samples.values()];
          // Do not take min(start)/max(end): a single bad overlapping window
          // otherwise stretches a highlight across the following words.
          let best = [], weight = -1;
          for (const seed of values) {
            const cluster = values.filter((w) => Math.abs(w.start - seed.start) <= 0.3 && Math.abs(w.end - seed.end) <= 0.5);
            const score = cluster.reduce((sum, w) => sum + w.quality, 0);
            if (score > weight) { best = cluster; weight = score; }
          }
          return { word, start: median(best.map((w) => w.start)), end: median(best.map((w) => w.end)) };
        }).sort((a, b) => a.word - b.word);
        // Never overlap two highlights or extrapolate through a missing word.
        for (let i = 0; i < words.length - 1; i++) words[i].end = Math.min(words[i].end, words[i + 1].start);
        cue.highlightWords = words.filter((w) => w.end > w.start);
        updated.add(i);
      }
    }
    this.trimHighlights(updated);
  }
  trimHighlights(indices = this.cues.keys()) {
    for (const i of indices) {
      if (i < 0 || i >= this.cues.length) continue;
      const cue = this.cues[i], until = this.cues[i + 1]?.t0 ?? this.until;
      if (cue.highlightWords) cue.highlightWords = cue.highlightWords.map((w) => ({ ...w, end: Math.min(w.end, until) }))
        .filter((w) => w.end > w.start);
    }
  }
  add(start, duration, result, playhead) {
    this.from ??= start;
    // Adaptive windows overlap: a shorter subsequent request must not shrink
    // the coverage already recognized by the preceding, longer window.
    this.until = Math.max(this.until ?? start, start + duration);
    this.history.push({ start, words: result.timedWords || [] });
    this.history = this.history.filter((w) => w.start >= start - 8);
    if (Array.isArray(result.timingMatches)) {
      // The recognizer assigns every supported token to its actual ayah in
      // the accepted passage, including multiple short ayahs in one window.
      // Do not reassign a repeated phrase from another ayah via per-verse LCS.
      const groups = new Map();
      for (const { match, spans } of result.timingMatches) {
        const group = groups.get(match.ref) || { match, spans: [] };
        group.spans.push(...spans);
        groups.set(match.ref, group);
      }
      for (const { match, spans } of [...groups.values()].sort((a, b) => a.match.pos - b.match.pos)) {
        this.addMatch(match, spans, result.newPassage === true);
      }
    } else if (result.timingMatch) {
      const match = result.timingMatch;
      const candidates = this.history.flatMap((window) => {
        const pairs = alignTimedWords(window.words, match).map((w) => ({ ...w,
          start: w.start + window.start, end: w.end + window.start }));
        return pairs.length >= Math.min(2, match.wordCount) ? pairs : [];
      });
      this.addMatch(match, candidates, result.newPassage === true);
    }
    // CPU look-ahead retains compact verse/word timings for session replay;
    // raw transcript history and PCM remain bounded independently.
    if (!this.retainCues) {
      while (this.cues.length > 1 && this.cues[1].t0 < playhead - 30) this.cues.shift();
    } else {
      // Match the original live buffer's retention boundary. Keep final word
      // timings for replay without dropping their consensus while still live.
      while (this.observationFloor < this.cues.length - 1 && this.cues[this.observationFloor + 1].t0 < playhead - 30) {
        this.observations.delete(this.cues[this.observationFloor++]);
      }
    }
  }
  addMatch(match, spans, newPassage = false) {
    let cue = this.cues.at(-1);
    // Reject stale overlapping audio, but permit a separately confirmed passage
    // to restart an earlier surah/ayah (including repeated Al-Fatiha in prayer).
    if (cue && match.pos < cue.match.pos && match.ref !== cue.match.ref && !newPassage) return;
    const continuing = cue?.match.ref === match.ref;
    // Greedy CTC may sustain the last character until the window's end. Its
    // end is not an admission boundary for the next ayah. Ordered, supported
    // word ONSETS are; valid new words may start before that stale end.
    const lower = continuing ? cue.lower : cue ? Math.max(...cue.words.map((w) => w.start)) + 0.001 : this.from;
    // Admission uses actual recognized-token ownership. An earlier acoustic
    // onset must not discard the first word and lose a short ayah. If it would
    // cross the previous ayah's last known word, keep the raw onset instead.
    const candidates = spans.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start &&
      (w.rawStart ?? w.start) >= lower).map((w) => ({ ...w, start: w.start < lower ? w.rawStart : w.start }));
    const wordCount = match.arabic.trim().split(/\s+/).filter((w) => normalizeArabic(w)).length;
    if (new Set(candidates.map((w) => w.word)).size < Math.min(2, wordCount)) return;
    if (!continuing) {
      cue = { match, lower, t0: Math.min(...candidates.map((w) => w.start)), words: [], lastEnd: lower };
      this.cues.push(cue);
    }
    for (const span of candidates) {
      const old = cue.words.find((w) => w.word === span.word);
      if (!old) cue.words.push({ ...span });
      else {
        old.start = Math.min(old.start, span.start);
        old.end = Math.max(old.end, span.end);
      }
    }
    cue.words.sort((a, b) => a.start - b.start);
    cue.t0 = Math.max(cue.lower, Math.min(cue.t0, cue.words[0].start));
    cue.lastEnd = Math.max(...cue.words.map((w) => w.end));
    if (!continuing && this.cues.length > 1) {
      const previous = this.cues.at(-2);
      previous.words = previous.words.map((w) => ({ ...w, end: Math.min(w.end, cue.t0) }));
      previous.lastEnd = Math.min(previous.lastEnd, cue.t0);
      this.trimHighlights([this.cues.length - 2]);
    }
  }
  payload(playhead = null) {
    if (playhead === null) return { from: this.from, until: this.until, cues: this.cues };
    // Preserve the full recognition cache here, not in every IPC/storage write.
    const cueFrom = Math.max(this.from ?? playhead, playhead - 30);
    const cueUntil = Math.min(this.until ?? playhead, playhead + 24);
    const from = Math.max(0, this.indexAt(cueFrom));
    const until = this.indexAt(cueUntil) + 1;
    return { from: this.from, until: this.until, cueFrom, cueUntil, cues: this.cues.slice(from, until) };
  }
}
