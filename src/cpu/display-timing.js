// Precise CTC alignment can reject an individual word without invalidating the
// recognizer's other, acoustically supported words. Fall back per word, not per
// ayah. Never extend a precise word across silence using a stale raw span.
const cache = new WeakMap();

export function displayTiming(cue) {
  const saved = cache.get(cue);
  if (saved?.raw === cue.words && saved.precise === cue.highlightWords) return saved.spans;
  const words = new Map((cue.words || []).map((w) => [w.word, w]));
  for (const span of cue.highlightWords || []) words.set(span.word, span);
  const spans = [...words.values()].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => ({ ...w })).sort((a, b) => a.word - b.word);
  for (let i = 0; i < spans.length - 1; i++) spans[i].end = Math.min(spans[i].end, spans[i + 1].start);
  const result = spans.filter((w) => w.end > w.start);
  cache.set(cue, { raw: cue.words, precise: cue.highlightWords, spans: result });
  return result;
}
