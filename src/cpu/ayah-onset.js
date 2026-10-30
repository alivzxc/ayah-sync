// CTC letter spikes identify words, but are not phonetic onset timestamps.
// Refine only the FIRST word of an already confirmed ayah. No text prediction,
// extra inference, or full PCM retention is involved.
export function firstWordOnset(envelope, spike, previousEnd = 0) {
  const { energy, step, threshold } = envelope;
  const lower = Math.min(spike, Math.max(0, previousEnd));
  const floor = Math.max(lower, spike - 1.5);
  const from = Math.max(0, Math.ceil(floor / step));
  const until = Math.min(energy.length - 1, Math.floor(spike / step));
  let quiet = 0, quietEnd = 0, voiced = 0;
  for (let i = until; i >= from; i--) {
    if (energy[i] < threshold) {
      if (!quiet) quietEnd = i;
      quiet++;
      // A real pause before voiced audio is stronger evidence than the first
      // emitted letter. Ignore very short consonant closures/noisy dips.
      if (quiet * step >= 0.12 && voiced * step >= 0.06) {
        return Math.max(lower, Math.min(spike, (quietEnd + 1) * step - 0.06));
      }
    } else {
      quiet = 0;
      voiced++;
    }
  }
  // Connected/noisy speech has no safe pause to rewind to. Use only a small
  // perceptual lead, never guess the beginning of an unheard earlier word.
  return Math.max(lower, spike - 0.12);
}
