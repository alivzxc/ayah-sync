// CPU audio scheduling only. Recognition still runs ~12 seconds ahead, never
// transcribes a whole download batch. Times here are absolute video seconds.
export const INITIAL_AUDIO_SECONDS = 180;
export const AUDIO_BATCH_SECONDS = 1800;
export const MAX_VIDEO_SECONDS = 10 * 60 * 60;

export function audioBatchPlan(duration, position = 0) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS || !Number.isFinite(position)) {
    throw new Error('CPU audio supports finite videos up to 10 hours');
  }
  const start = Math.max(0, Math.floor(Math.min(Math.max(0, position), duration)) - 10);
  const initial = { start, end: Math.min(duration, start + INITIAL_AUDIO_SECONDS), phase: 'initial' };
  const rest = [];
  for (let from = initial.end; from < duration; from += AUDIO_BATCH_SECONDS) {
    rest.push({ start: from, end: Math.min(duration, from + AUDIO_BATCH_SECONDS), phase: 'background' });
  }
  for (let end = start; end > 0; end -= AUDIO_BATCH_SECONDS) {
    rest.push({ start: Math.max(0, end - AUDIO_BATCH_SECONDS), end, phase: 'background' });
  }
  return { initial, rest };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class BatchedAudioSource {
  constructor({ duration, position, signal, download, open, store, onProgress = () => {} }) {
    this.duration = duration; this.sampleRate = 16000;
    this.signal = signal; this.download = download; this.open = open; this.store = store; this.onProgress = onProgress;
    this.plan = audioBatchPlan(duration, position);
    this.jobs = []; this.urgent = []; this.records = []; this.inputs = new Map();
    this.closed = false; this.active = null; this.running = null; this.serial = 0;
    this.abort = () => this.close();
    signal.addEventListener('abort', this.abort, { once: true });
  }
  check() { this.signal.throwIfAborted(); if (this.closed) throw new DOMException('Audio source closed', 'AbortError'); }
  find(time) {
    return this.records.filter((r) => this.store.has(r.id) && r.start <= time + 1e-6 && r.end > time + 1e-6)
      .sort((a, b) => b.end - a.end)[0];
  }
  covers(start, end) {
    let time = start;
    while (time < end - 1e-6) { const record = this.find(time); if (!record) return false; time = record.end; }
    return true;
  }
  enqueue(range) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Background failures are retried on demand, never unhandled rejections.
    promise.catch(() => {});
    const job = { ...range, promise, resolve, reject };
    if (range.phase === 'background') this.jobs.push(job);
    else this.urgent.unshift(job);
    return job;
  }
  async prepare() {
    this.check();
    const first = this.enqueue(this.plan.initial);
    this.pump();
    await first.promise;
    this.check();
    for (const range of this.plan.rest) this.enqueue(range);
    // Give the caller the source immediately; no 30-minute batch gates startup.
    this.pump();
    return this;
  }
  pump() {
    if (this.running || this.closed) return;
    this.running = this.run().finally(() => { this.running = null; if (!this.closed && (this.urgent.length || this.jobs.length)) this.pump(); });
  }
  async run() {
    while (!this.closed && (this.urgent.length || this.jobs.length)) {
      const job = this.urgent.shift() || this.jobs.shift();
      if (this.covers(job.start, job.end)) { job.resolve(); continue; }
      const controller = new AbortController();
      this.active = { job, controller };
      const signal = AbortSignal.any([this.signal, controller.signal, ...(job.requestSignal ? [job.requestSignal] : [])]);
      const progress = (p) => { if (!signal.aborted && !this.closed) this.onProgress({ ...p, phase: job.phase, start: job.start, end: job.end }); };
      try {
        signal.throwIfAborted();
        const result = await this.download({ ...job, signal, onProgress: progress });
        signal.throwIfAborted();
        // Validate/open the initial/seek batch before declaring it ready. Later
        // batches remain compressed and are only opened when a window needs them.
        let input = null;
        try {
          if (job.phase !== 'background') input = await this.open(result.blob, result, signal);
          signal.throwIfAborted();
          const id = String(++this.serial);
          await this.store.put(id, result.blob);
          signal.throwIfAborted();
          this.records.push({ id, start: job.start, end: job.end, metadata: { start: result.start, end: result.end } });
          if (input) { this.keepInput(id, input); input = null; }
          this.records = this.records.filter((r) => this.store.has(r.id));
          for (const [key, value] of this.inputs) if (!this.store.has(key)) { value.close(); this.inputs.delete(key); }
          progress({ stage: 'ready', received: result.blob.size, total: result.blob.size });
          job.resolve();
        } finally { input?.close(); }
      } catch (error) {
        this.lastFailure = { start: job.start, end: job.end, error };
        if (!signal.aborted) progress({ stage: 'failed' });
        job.reject(error);
      } finally { this.active = null; }
    }
  }
  keepInput(id, input) {
    this.inputs.delete(id); this.inputs.set(id, input);
    while (this.inputs.size > 2) {
      const [old, value] = this.inputs.entries().next().value;
      value.close(); this.inputs.delete(old);
    }
  }
  async ensure(start, end, signal) {
    this.check(); signal.throwIfAborted();
    if (this.covers(start, end)) return;
    let job = [this.active?.job, ...this.urgent].find((j) => j && !j.requestSignal?.aborted &&
      !(j === this.active?.job && this.active.controller.signal.aborted) &&
      j.phase !== 'background' && j.start <= start && j.end >= end);
    if (!job) {
      job = this.enqueue({ start: Math.max(0, Math.floor(start)), end: Math.min(this.duration,
        Math.max(end, Math.floor(start) + INITIAL_AUDIO_SECONDS)), phase: 'seek', requestSignal: signal });
      if (this.active && !this.active.controller.signal.aborted) {
        if (this.active.job.phase === 'background') this.jobs.unshift(this.active.job);
        this.active.controller.abort();
      }
    }
    this.pump();
    await abortable(job.promise, signal);
    this.check(); signal.throwIfAborted();
  }
  async window(start, { signal = this.signal } = {}) {
    this.check(); signal.throwIfAborted();
    if (!Number.isFinite(start) || start < 0 || start >= this.duration) throw new Error('Invalid audio window position');
    start = Math.floor(start * 16000) / 16000;
    const end = Math.min(this.duration, start + 20), audio = new Float32Array(Math.round((end - start) * 16000));
    const selected = [];
    // Pin all parts before the first asynchronous decoder read. In particular,
    // background cache eviction must not remove part two of a boundary window.
    while (!selected.length) {
      await this.ensure(start, end, signal);
      let scan = start;
      while (scan < end - 1e-6) {
        const record = this.find(scan);
        if (!record) { selected.length = 0; break; }
        selected.push(record); scan = Math.min(end, record.end);
      }
    }
    for (const record of selected) this.store.pin?.(record.id);
    let time = start;
    try {
      for (const record of selected) {
        signal.throwIfAborted(); this.check();
        let input = this.inputs.get(record.id);
        if (!input) input = await this.open(await this.store.get(record.id), record.metadata, signal);
        this.keepInput(record.id, input);
        const until = Math.min(end, record.end);
        const pcm = await input.read(time, until, signal);
        signal.throwIfAborted(); this.check();
        const offset = Math.round((time - start) * 16000), length = Math.round((until - time) * 16000);
        if (!(pcm instanceof Float32Array) || Math.abs(pcm.length - length) > 1) throw new Error('Invalid decoded audio window');
        audio.set(pcm.subarray(0, Math.min(length, audio.length - offset)), offset);
        time = until;
      }
    } finally { for (const record of selected) this.store.unpin?.(record.id); }
    return { start, sampleRate: 16000, audio };
  }
  close() {
    if (this.closed) return this.closing;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    this.active?.controller.abort();
    for (const job of [...this.urgent, ...this.jobs]) job.reject(new DOMException('Stopped', 'AbortError'));
    this.urgent = []; this.jobs = [];
    for (const input of this.inputs.values()) input.close();
    this.inputs.clear(); this.records = [];
    this.closing = Promise.resolve(this.running).finally(() => this.store.close());
    this.closing.catch(() => {});
    return this.closing;
  }
}
