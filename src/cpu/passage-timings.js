import { normalizeArabic } from './match.js';
import { firstWordOnset } from './ayah-onset.js';

// Keep exact matcher token ownership when converting CTC evidence to timings.
// Per-ayah realignment would assign identical refrains to the wrong occurrence.
export function passageTimings(matches) {
  return matches.filter((m) => m.observation).map(({ match, evidence, observation, recoveredPrefix }) => {
    const heard = observation.words.flatMap((w) => normalizeArabic(w.text).split(' ').filter(Boolean).map(() => w));
    const first = match.arabic.trim().split(/\s+/).findIndex((w) => normalizeArabic(w));
    return { match, ...(recoveredPrefix ? { recoveredPrefix: true } : {}), spans: evidence.flatMap(({ heard: i, word }) => {
      const timed = heard[i];
      if (!timed) return [];
      const rawStart = observation.start + timed.start;
      const previous = observation.words[observation.words.indexOf(timed) - 1];
      const start = word === first && observation.envelope
        ? observation.start + firstWordOnset(observation.envelope, timed.start, previous?.end || 0) : rawStart;
      return [{ word, start, end: observation.start + timed.end, ...(start < rawStart ? { rawStart } : {}) }];
    }) };
  });
}
