import { normalizeArabic } from './match.js';

// Read timing from the same greedy path used for transcription. No second
// inference, forced transcript, or change to the recognized text is involved.
export function decodeCtc(logProbabilities, frameCount, tokens, duration) {
  let previous = 0;
  let text = '';
  const words = [];
  let word = null;
  const step = duration / frameCount;
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * tokens.length;
    let best = 0;
    for (let token = 1; token < tokens.length; token++) {
      if (logProbabilities[offset + token] > logProbabilities[offset + best]) best = token;
    }
    if (best !== 0 && best !== previous) {
      const token = tokens[best] || '';
      text += token;
      for (const char of token.replaceAll('\u2581', ' ')) {
        if (/\s/.test(char)) {
          word = null;
        } else {
          if (!word) {
            word = { text: '', start: frame * step, end: (frame + 1) * step };
            words.push(word);
          }
          word.text += char;
          word.end = (frame + 1) * step;
        }
      }
    } else if (best !== 0 && word) {
      word.end = (frame + 1) * step;
    }
    previous = best;
  }
  return { text: text.replaceAll('\u2581', ' ').trim().replace(/\s+/g, ' '), words };
}

export function wordHighlight(words, match, duration) {
  if (!match) return null;
  const clear = { ref: match.ref, word: -1, ageMs: 0 };
  // Align only to words already supported by the unchanged passage matcher.
  // Keep display-word indices: Quranic pause signs normalize to empty strings.
  const target = [];
  const displayWords = match.arabic.trim().split(/\s+/);
  for (let i = Math.max(0, match.word - 40); i <= match.word && i < displayWords.length; i++) {
    for (const text of normalizeArabic(displayWords[i]).split(' ').filter(Boolean)) target.push({ text, word: i });
  }
  const heard = words.map((w) => ({ ...w, normalized: normalizeArabic(w.text) }));
  // Exact normalized-token LCS tolerates omitted/noisy words without assigning
  // a timestamp to an unheard token. This is display-only, never passage voting.
  const rows = Array.from({ length: heard.length + 1 }, () => new Uint16Array(target.length + 1));
  for (let i = 1; i <= heard.length; i++) {
    for (let j = 1; j <= target.length; j++) {
      rows[i][j] = heard[i - 1].normalized === target[j - 1].text
        ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  if (rows[heard.length][target.length] < Math.min(2, target.length) || !target.length) return clear;
  let i = heard.length, j = target.length;
  while (i && j) {
    if (heard[i - 1].normalized === target[j - 1].text) {
      // Don't highlight a previous word while the transcript's tail is unknown.
      if (i !== heard.length) return clear;
      const ageMs = Math.max(0, (duration - heard[i - 1].end) * 1000);
      return { ref: match.ref, word: target[j - 1].word, ageMs };
    }
    if (rows[i - 1][j] > rows[i][j - 1]) i--;
    else j--;
  }
  return clear;
}
