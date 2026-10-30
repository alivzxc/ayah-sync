// Fixed overlapping windows keep recognition independent of speech pauses.
export class RecognitionScheduler {
  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset() {
    this.total = this.submitted = 0;
    this.responsive = false;
  }

  updateTracking(tracking, inferenceMs, threads) {
    // Spend the extra CPU only at an ayah boundary, and only when measured
    // inference is fast. Keep the normal cadence on slower/single-core CPUs.
    this.responsive = !!tracking?.locked && !!tracking.nearEnd && threads > 1 && inferenceMs <= 100;
  }

  freshSeconds() {
    return (this.total - this.submitted) / this.sampleRate;
  }

  push(frame) {
    this.total += frame.length;
  }

  due() {
    const sr = this.sampleRate;
    const fresh = this.total - this.submitted;
    return !this.submitted
      ? this.total >= 4 * sr ? 'identify' : null
      : fresh >= (this.responsive ? 0.25 : 0.5) * sr ? 'track' : null;
  }

  submittedNow() {
    this.submitted = this.total;
  }

  windowSamples() {
    return 4 * this.sampleRate;
  }
}
