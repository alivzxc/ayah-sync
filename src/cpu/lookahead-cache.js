import { LookaheadBuffer } from './lookahead-buffer.js';

// Per-video, in-memory recognition results only: no PCM or model scores.
export class LookaheadCache {
  constructor() { this.segments = []; this.current = null; this.nextId = 0; }
  at(time) {
    return this.segments.filter((s) => s.buffer.from !== null && s.buffer.from <= time && time <= s.buffer.until)
      .sort((a, b) => b.buffer.until - a.buffer.until)[0] || null;
  }
  select(time) {
    if (this.current) {
      this.current.buffer.history = [];
      this.current.buffer.observations = new WeakMap();
    }
    let segment = this.at(time);
    if (!segment) {
      let start = Math.max(0, Math.floor(time) - 10);
      // Don't recognize a cached tail again just to build seek pre-roll.
      for (const s of this.segments) {
        if (s.buffer.until !== null && s.buffer.until <= time) start = Math.max(start, s.buffer.until);
      }
      segment = { id: ++this.nextId, buffer: new LookaheadBuffer({ retainCues: true }), cursor: start, ready: false };
      this.segments.push(segment);
    }
    this.current = segment;
    return segment;
  }
  merge() {
    const active = this.current;
    if (!active || active.buffer.from === null) return false;
    let jumped = false;
    for (const segment of [...this.segments]) {
      if (segment === active || segment.buffer.from === null ||
          segment.buffer.from > active.buffer.until || segment.buffer.until < active.buffer.from) continue;
      const buffer = active.buffer;
      const cues = [...buffer.cues, ...segment.buffer.cues].sort((a, b) => a.t0 - b.t0);
      buffer.cues = [];
      for (const cue of cues) {
        const previous = buffer.cues.at(-1);
        if (previous?.match.ref === cue.match.ref && cue.t0 <= previous.lastEnd + 0.5) {
          for (const field of ['words', 'highlightWords']) {
            if (!cue[field]) continue;
            const words = new Map((previous[field] || []).map((w) => [w.word, w]));
            for (const word of cue[field]) if (!words.has(word.word)) words.set(word.word, word);
            previous[field] = [...words.values()].sort((a, b) => a.start - b.start);
          }
          previous.lastEnd = Math.max(previous.lastEnd, cue.lastEnd);
        } else buffer.cues.push(cue);
      }
      buffer.from = Math.min(buffer.from, segment.buffer.from);
      buffer.until = Math.max(buffer.until, segment.buffer.until);
      buffer.observationFloor = 0;
      buffer.trimHighlights();
      if (segment.cursor > active.cursor) { active.cursor = segment.cursor; jumped = true; }
      active.ready ||= segment.ready;
      this.segments.splice(this.segments.indexOf(segment), 1);
    }
    return jumped;
  }
  timeline() {
    const segments = this.segments.filter((s) => s.buffer.from !== null).sort((a, b) => a.buffer.from - b.buffer.from);
    return {
      ranges: segments.map((s) => ({ id: s.id, from: s.buffer.from, until: s.buffer.until })),
      marks: segments.flatMap((s) => s.buffer.cues.map((c) => c.t0)),
    };
  }
  clear() { this.segments = []; this.current = null; }
}
