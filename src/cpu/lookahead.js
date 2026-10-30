import { LookaheadCache } from './lookahead-cache.js';
import { StartupBuffer, CPU_LOOKAHEAD_SECONDS, CPU_AMBIGUOUS_LOOKAHEAD_SECONDS } from './startup-buffer.js';

const SR = 16000;
const AHEAD = CPU_LOOKAHEAD_SECONDS;

// Exclusive alternative to live tab capture. One worker, one PCM block and one
// inference request; compressed audio may download independently in background.
export function startLookahead({ url, media, startTime = 0, key, captureEpoch, highlightEnabled = false,
  youtubeId = null, directMedia = false, mediaCredentials = 'omit', expectedDuration, helperAvailable = true, onUnavailable }, send) {
  let stopped = false, generation = 0, epoch = captureEpoch;
  let worker = null, workerRequest = null, audioRequest = null;
  let socket = null, socketReady = false, initialized = false;
  let browserSource = null;
  let preparation = null, closing = null;
  const download = new AbortController();
  let windowAbort = new AbortController();
  let modelReady = false;
  let source = null, block = null, cursor = null, requestId = 0;
  let lastClock = null, publishedPlayhead = null;
  let timer = null;
  let prepareTimer = null;
  let alignWords = highlightEnabled, refinePending = false;
  let tracking = null;
  const cache = new LookaheadCache();
  let segment = null, buffer = null;
  let replaying = false;
  let seekCheck = false;
  let extendedSeekCheck = false;
  const startup = new StartupBuffer(AHEAD);
  function publish(playhead) {
    publishedPlayhead = playhead;
    startup.seconds = seekCheck && extendedSeekCheck ? CPU_AMBIGUOUS_LOOKAHEAD_SECONDS : AHEAD;
    let progress = startup.update(playhead, source.duration, buffer.from, buffer.until);
    // First inspect twelve seconds after a seek. Only unresolved competing
    // locations extend that first check; consecutive ayahs are not ambiguity.
    if (seekCheck && !extendedSeekCheck && progress.ready && new Set(tracking?.ambiguousRefs || []).size > 1) {
      extendedSeekCheck = true;
      startup.reset(CPU_AMBIGUOUS_LOOKAHEAD_SECONDS);
      progress = startup.update(playhead, source.duration, buffer.from, buffer.until);
    }
    if (progress.ready) seekCheck = false;
    segment.ready ||= progress.ready;
    const payload = buffer.payload(playhead);
    send({ type: 'BUFFER', key, duration: source.duration, ...payload, ...progress,
      ...cache.timeline(), segmentId: segment.id,
      cues: progress.ready ? payload.cues : [], captureEpoch: epoch });
  }
  const setHighlight = (enabled) => {
    alignWords = enabled === true;
    refinePending = alignWords;
  };
  const debug = (text) => send({ type: 'DEBUG', text: `CPU look-ahead · ${text}` });
  function stop() {
    if (stopped) return closing;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(prepareTimer);
    clearTimeout(workerRequest?.timer);
    clearTimeout(audioRequest?.timer);
    worker?.terminate(); socket?.close();
    const sourceClosed = browserSource?.close();
    windowAbort.abort(); download.abort(); browserSource = null;
    workerRequest?.reject(new Error('Stopped'));
    audioRequest?.reject(new Error('Stopped'));
    workerRequest = audioRequest = null;
    block = null;
    cache.clear(); buffer = segment = null;
    closing = Promise.allSettled([sourceClosed, preparation]);
    return closing;
  }
  function fail(error) {
    if (stopped) return;
    const preparing = !initialized;
    stop();
    if (preparing && onUnavailable) {
      Promise.resolve(onUnavailable()).catch(() => send({ type: 'ERROR', error: 'Could not switch to CPU live listening. Open the popup and try live-only.' }));
      return;
    }
    send({ type: 'ERROR', error: `CPU look-ahead: ${error.message || error}. Use CPU live-only if this video cannot be downloaded.` });
  }
  function askWorker(data) {
    return new Promise((resolve, reject) => {
      workerRequest = { resolve, reject, timer: setTimeout(() => reject(new Error('CPU worker timed out')), 60000) };
      worker.postMessage(data, data.audio ? [data.audio.buffer] : []);
    });
  }
  async function loadWorker(maxThreads = 4) {
    worker = new Worker(new URL('./recognition-worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (e) => workerRequest?.reject(new Error(e.message));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') send({ type: 'MODEL_PROGRESS', progress: data });
      else if (data.type === 'error') {
        clearTimeout(workerRequest?.timer);
        workerRequest?.reject(new Error(data.error));
      } else {
        clearTimeout(workerRequest?.timer);
        workerRequest?.resolve(data); workerRequest = null;
      }
    };
    try {
      return await askWorker({ type: 'init', baseURL: chrome.runtime.getURL(''), maxThreads });
    } catch (error) {
      if (maxThreads === 1 || stopped) throw error;
      worker.terminate();
      return loadWorker(1);
    }
  }
  function requestAudio(start) {
    if (browserSource) return browserSource.window(start, { signal: windowAbort.signal });
    return new Promise((resolve, reject) => {
      audioRequest = { id: ++requestId, resolve, reject,
        // A seek may need to download an uncached CPU audio batch.
        timer: setTimeout(() => reject(new Error('Audio window timed out')), 7230000) };
      socket.send(JSON.stringify({ type: 'cpu_audio_window', id: requestId, start, seconds: 20 }));
    });
  }
  function reset(nextEpoch, time = null, seeking = true) {
    epoch = nextEpoch ?? epoch;
    generation++;
    windowAbort.abort(); windowAbort = new AbortController();
    if (seeking) seekCheck = true;
    extendedSeekCheck = false;
    cursor = null; lastClock = null; block = null; tracking = null;
    startup.reset(AHEAD);
    // An outstanding single-flight inference is allowed to finish and is
    // discarded by generation. The reset message is processed before new audio.
    worker?.postMessage({ type: 'reset' });
    // A seek during download/model loading must not replace that phase's UI
    // with an empty recognition buffer. The first loop reads the latest clock.
    if (!source || !modelReady) return;
    if (Number.isFinite(time)) selectPosition(time);
    else send({ type: 'BUFFER', key, duration: source?.duration, ...cache.timeline(),
      from: null, until: null, cues: [], ready: false,
      preparedSeconds: 0, requiredSeconds: startup.seconds, captureEpoch: epoch });
  }
  function selectPosition(time) {
    segment = cache.select(time);
    replaying = segment.ready;
    buffer = segment.buffer;
    cursor = segment.cursor;
    startup.ready = !seekCheck && segment.ready;
    publish(time);
  }
  function alignmentCues() {
    // Keep the full 24-window acoustic context used by the original recognizer.
    // The replay cache must not shorten word-timing refinement to 12 seconds.
    const cues = [];
    const from = Math.max(0, buffer.indexAt(cursor - 24));
    for (let i = from; i < buffer.cues.length && buffer.cues[i].t0 <= cursor + 4; i++) {
      const cue = buffer.cues[i];
      cues.push({ match: cue.match, t0: cue.t0, until: buffer.cues[i + 1]?.t0 ?? buffer.until,
        complete: i + 1 < buffer.cues.length });
    }
    return cues;
  }
  async function loop() {
    if (stopped) return;
    let submitted = generation;
    try {
      const clock = await chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' });
      if (stopped) return;
      if (submitted !== generation) { timer = setTimeout(loop, 0); return; }
      if (!clock || clock.key !== key || !Number.isFinite(clock.time)) {
        timer = setTimeout(loop, 1000); return;
      }
      if (directMedia && clock.src !== media) throw new Error('Media source changed. Start CPU sync again.');
      if (clock.seeking || Math.abs(clock.duration - source.duration) > 5) {
        timer = setTimeout(loop, 500); return;
      }
      const clockAt = performance.now();
      const elapsed = lastClock ? Math.max(0, clockAt - lastClock.at) / 1000 : 0;
      const expected = lastClock ? lastClock.time + (lastClock.paused ? 0 : elapsed * lastClock.rate) : clock.time;
      // A slow inference/download is not a seek. Compare against elapsed media
      // time, not a fixed four-second advance, and keep contiguous work on underrun.
      const continuous = !lastClock || (clock.paused === lastClock.paused && (clock.playbackRate || 1) === lastClock.rate);
      if (cursor === null || clock.time < (buffer?.from ?? clock.time) || (continuous && Math.abs(clock.time - expected) > 4)) {
        reset(epoch, clock.time, cursor !== null || lastClock !== null);
      }
      lastClock = { time: clock.time, at: clockAt, paused: clock.paused, rate: clock.playbackRate || 1 };
      submitted = generation;
      if (alignWords && refinePending && buffer.cues.length) {
        refinePending = false;
        const result = await askWorker({ type: 'align', cues: alignmentCues() });
        if (stopped) return;
        if (submitted !== generation) { timer = setTimeout(loop, 0); return; }
        buffer.applyAlignments(result.alignedWindows);
        publish(clock.time);
      }
      const horizon = seekCheck && extendedSeekCheck ? CPU_AMBIGUOUS_LOOKAHEAD_SECONDS : AHEAD;
      if ((clock.paused && replaying && startup.ready) || buffer.until >= source.duration - 0.001 || cursor >= clock.time + horizon) {
        // Cached segments can cover minutes or hours, but each IPC payload only
        // carries nearby cues. Refresh that slice even when no ASR is needed.
        if (publishedPlayhead === null || Math.abs(clock.time - publishedPlayhead) >= AHEAD) publish(clock.time);
        debug(`buffer ready · ${Math.max(0, cursor - clock.time).toFixed(0)}s ahead`);
        timer = setTimeout(loop, 1000); return;
      }
      // Include the final partial second (and videos shorter than four seconds)
      // so the 12-second gate can also complete near the end of a video.
      // More context resolves shared phrases after seeks and preserves short
      // ayahs at boundaries. Keep the cheaper four-second window within an ayah.
      const windowSeconds = !tracking?.locked || tracking.nearEnd ? 8 : 4;
      cursor = Math.min(cursor, Math.max(0, source.duration - 4));
      if (!block || cursor < block.start || Math.min(source.duration, cursor + windowSeconds) > block.start + block.audio.length / SR) {
        const data = await requestAudio(cursor);
        if (stopped || submitted !== generation) { timer = setTimeout(loop, 0); return; }
        if (data.sampleRate !== SR || (data.audio ? !(data.audio instanceof Float32Array) || data.audio.length > 24 * SR
          : typeof data.pcm !== 'string' || data.pcm.length > 24 * SR * 4 * 4 / 3 + 4)) {
          throw new Error('Invalid or oversized audio window');
        }
        block = { start: data.start, audio: data.audio || new Float32Array(
          Uint8Array.from(atob(data.pcm), (c) => c.charCodeAt(0)).buffer) };
      }
      const offset = Math.round((cursor - block.start) * SR);
      const samples = Math.round(Math.min(windowSeconds, source.duration - cursor) * SR);
      const audio = block.audio.slice(offset, offset + samples);
      if (audio.length < samples - 1 || !audio.length) throw new Error('Audio ended before the requested window');
      const start = cursor;
      const audioDuration = audio.length / SR;
      const result = await askWorker({ type: 'audio', audio, generation: submitted, freshSeconds: 1,
        timings: true, audioStart: start, alignWords });
      if (stopped) return;
      if (submitted === generation) {
        tracking = result.tracking;
        replaying = false;
        buffer.add(start, audioDuration, result, clock.time);
        if (alignWords && buffer.cues.length) {
          const alignment = await askWorker({ type: 'align', cues: alignmentCues() });
          if (stopped) return;
          if (submitted !== generation) { timer = setTimeout(loop, 0); return; }
          buffer.applyAlignments(alignment.alignedWindows);
        }
        cursor++;
        segment.cursor = cursor;
        if (cache.merge()) {
          cursor = segment.cursor;
          block = null;
          worker.postMessage({ type: 'reset' });
          tracking = null;
        }
        publish(clock.time);
        debug(`recognizing ahead · ${result.ms}ms · ${Math.max(0, cursor - clock.time).toFixed(0)}s buffered`);
      }
      // Aim for one-third duty while buffered, but don't spend the remaining
      // lead sleeping on a slower CPU. Include decoding/alignment time as well.
      const spareMs = (buffer.until - clock.time - AHEAD / 2) * 1000 - (performance.now() - clockAt);
      timer = setTimeout(loop, Math.max(100, Math.min((result.ms || 0) * 2, spareMs)));
    } catch (error) {
      if (stopped) return;
      if (submitted !== generation && error.name === 'AbortError') { timer = setTimeout(loop, 0); return; }
      fail(error);
    }
  }
  async function begin() {
    if (initialized || !source || (!browserSource && !socketReady) || stopped) return;
    initialized = true;
    debug('loading CPU model…');
    send({ type: 'STATUS', status: 'loading-model', detail: 'CPU sync · loading CPU model…' });
    try {
      const ready = await loadWorker();
      if (stopped) return;
      modelReady = true;
      debug(`${ready.threads} thread(s) · preparing the next ${AHEAD}s`);
      send({ type: 'STATUS', status: 'listening' });
      loop();
    } catch (error) { fail(error); }
  }
  function connectHelper() {
    debug(youtubeId || directMedia ? 'Browser download unavailable · trying the local audio helper…' : 'fetching video audio in background…');
    prepareTimer = setTimeout(() => fail(new Error('Audio preparation timed out. Restart the local helper and try again.')), 300000);
    socket = new WebSocket('ws://127.0.0.1:8790');
    socket.onopen = async () => {
      let position = Number.isFinite(startTime) ? startTime : 0;
      try {
        const clock = await chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' });
        if (clock?.key === key && Number.isFinite(clock.time)) position = clock.time;
      } catch {}
      if (!stopped) socket.send(JSON.stringify({ type: 'cpu_audio_prepare', url, media, position }));
    };
    socket.onerror = () => fail(new Error('Audio helper unavailable'));
    socket.onclose = () => { if (!stopped) fail(new Error('Audio helper disconnected')); };
    socket.onmessage = ({ data: message }) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ready') socketReady = true;
        else if (data.type === 'cpu_audio_progress') {
          debug(`fetching audio · ${Math.round(data.pct * 100)}%`);
          const phase = data.stage === 'resolving' ? 'finding audio source' : 'downloading 3 min at playback position';
          send({ type: 'STATUS', status: 'loading-model', detail: `CPU sync · ${phase} · ${data.elapsedSeconds || 0}s elapsed…` });
        }
        else if (data.type === 'cpu_audio_error') throw new Error(data.error);
        else if (data.type === 'cpu_audio_ready') {
          clearTimeout(prepareTimer);
          if (data.sampleRate !== SR || !Number.isFinite(data.duration)) throw new Error('Invalid audio metadata');
          source = data;
          send({ type: 'CPU_AUDIO_SOURCE', source: 'helper' });
        } else if (data.type === 'cpu_audio_window' && audioRequest?.id === data.id) {
          clearTimeout(audioRequest.timer);
          audioRequest.resolve(data); audioRequest = null;
        }
        begin();
      } catch (error) { fail(error); }
    };
  }
  preparation = (async () => {
    if (youtubeId || directMedia) {
      debug(youtubeId ? 'starting YouTube.js browser download…' : 'opening standard media audio in browser…');
      let lastProgress = 0;
      try {
        const prepare = youtubeId ? (await import('./youtube-source.js')).prepareYoutubeAudio
          : (await import('./direct-media-source.js')).prepareDirectMedia;
        let position = Number.isFinite(startTime) ? startTime : 0;
        try {
          const clock = await chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' });
          if (clock?.key === key && Number.isFinite(clock.time)) position = clock.time;
        } catch {}
        const prepared = await prepare({ videoId: youtubeId, url: media, credentials: mediaCredentials,
          expectedDuration, position, signal: download.signal,
          onProgress(progress) {
            if (stopped || (Date.now() - lastProgress < 300 && !['ready', 'failed'].includes(progress.stage))) return;
            lastProgress = Date.now();
            if (progress.phase !== 'initial') {
              send({ type: 'CPU_AUDIO_BATCH', progress });
              return;
            }
            const phase = { session: youtubeId ? 'creating YouTube.js session' : 'opening standard media audio', attestation: 'checking YouTube playback attestation',
              download: 'downloading the first 3 min at your playback position', decode: 'preparing browser audio',
              ready: 'first audio batch ready', failed: 'audio download failed' }[progress.stage];
            const pct = progress.stage === 'download' && progress.total > 0 ? ` · ${Math.min(100, Math.round(progress.received / progress.total * 100))}%` : '';
            send({ type: 'STATUS', status: 'loading-model', detail: `CPU sync · ${phase}${pct}…` });
          } });
        if (stopped) { await prepared.close(); return; }
        browserSource = prepared; source = prepared;
        send({ type: 'CPU_AUDIO_SOURCE', source: youtubeId ? 'youtubejs' : 'direct' });
        begin();
        return;
      } catch (error) {
        if (stopped) return;
        debug(`${youtubeId ? 'YouTube.js' : 'Direct media'} download blocked or unsupported · ${(error.message || 'audio preparation failed').slice(0, 160)}`);
        if (!helperAvailable) return fail(new Error('Browser audio download unavailable'));
      }
    }
    if (!helperAvailable) return fail(new Error('No audio download source is available'));
    connectHelper();
  })().catch(fail);
  return { stop, reset, setHighlight };
}
