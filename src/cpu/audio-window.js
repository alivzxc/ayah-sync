// Bounded rolling buffer; inference never queues audio windows.
export class AudioWindow {
  constructor(capacity = 96000) {
    this.buffer = new Float32Array(capacity);
    this.reset();
  }
  reset() { this.cursor = 0; this.length = 0; this.total = 0; }
  push(frame) {
    for (const sample of frame) {
      this.buffer[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % this.buffer.length;
    }
    this.length = Math.min(this.buffer.length, this.length + frame.length);
    this.total += frame.length;
  }
  snapshot(maxSamples = this.length, trailingSamples = 0) {
    const skip = Math.min(this.length, Math.max(0, Math.floor(trailingSamples)));
    const length = Math.min(this.length - skip, maxSamples);
    const out = new Float32Array(length);
    const start = (this.cursor - skip - length + this.buffer.length) % this.buffer.length;
    for (let i = 0; i < out.length; i++) out[i] = this.buffer[(start + i) % this.buffer.length];
    return out;
  }
}
