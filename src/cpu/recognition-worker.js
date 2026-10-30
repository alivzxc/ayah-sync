import { createRecognizer } from './local-recognizer.js';

// CPU ONLY worker: shared by browser live listening and CPU look-ahead.
let recognizer;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      recognizer = await createRecognizer(data.baseURL, (p) => {
        if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
      }, data.maxThreads || 4);
      self.postMessage({ type: 'ready', threads: recognizer.threads || 1 });
    } else if (data.type === 'reset') {
      recognizer?.reset(data.keepContext);
    } else if (data.type === 'audio' && recognizer) {
      self.postMessage({ type: 'result', generation: data.generation,
        ...await recognizer.recognize(data.audio, data.freshSeconds, data.timings,
          { alignWords: data.alignWords, audioStart: data.audioStart }) });
    } else if (data.type === 'align' && recognizer) {
      const start = performance.now();
      self.postMessage({ type: 'alignment', alignedWindows: recognizer.refineTimings(data.cues || []),
        ms: performance.now() - start });
    }
  } catch (error) {
    self.postMessage({ type: 'error', initializing: data.type === 'init', error: error.message || String(error) });
  }
};
