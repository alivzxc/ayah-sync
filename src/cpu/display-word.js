import { normalizeArabic } from './match.js';

// The same canonical ayah has different glyphs AND word spacing across scripts.
// Align letters once per ayah; one acoustic word can occupy multiple display
// spans, or two acoustic words can share an unspaced display span.
const cache = new Map();
const scriptText = (text) => normalizeArabic(text.replace(/ٮٕ/g, 'ئ')
  .replace(/[کڪ]/g, 'ك').replace(/[یٮ]/g, 'ي').replace(/[ہھ]/g, 'ه'));

export function displayWordIndices(source, display, word) {
  if (word < 0) return [];
  if (source === display) return [word];
  const key = `${source}\0${display}`;
  if (cache.has(key)) return cache.get(key)[word] || [];
  const tokenize = (text) => text.trim().split(/\s+/).flatMap((w, index) =>
    [...scriptText(w).replace(/\s/g, '')].map((text) => ({ text, index })));
  const a = tokenize(source), b = tokenize(display);
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1].text === b[j - 1].text ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const pairs = new Map(), totals = new Map();
  for (const item of a) totals.set(item.index, (totals.get(item.index) || 0) + 1);
  let i = a.length, j = b.length;
  while (i && j) {
    if (a[i - 1].text === b[j - 1].text) {
      const entry = pairs.get(a[i - 1].index) || { count: 0, indices: new Set() };
      entry.count++; entry.indices.add(b[j - 1].index);
      pairs.set(a[i - 1].index, entry);
      i--; j--;
    } else if (rows[i - 1][j] > rows[i][j - 1]) i--;
    else j--;
  }
  const mapping = {};
  for (const [word, entry] of pairs) {
    if (entry.count >= Math.ceil(totals.get(word) * 0.8)) mapping[word] = [...entry.indices].sort((a, b) => a - b);
  }
  cache.set(key, mapping);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return mapping[word] || [];
}

export function displayWordIndex(source, display, word) {
  return displayWordIndices(source, display, word)[0] ?? -1;
}
