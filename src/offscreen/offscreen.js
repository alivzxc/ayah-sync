/** Tab capture, with browser-only CPU inference or the optional Python helper. */
import { AudioWindow } from '../cpu/audio-window.js';
import { RecognitionScheduler } from '../cpu/recognition-scheduler.js';
import { recognitionCooldown } from '../cpu/live-pacing.js';
const DEV_MODE = import.meta.env.DEV;

const SERVER_URL = 'ws://127.0.0.1:8790';
const SAMPLE_RATE = 16000; // must match the server

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let ws = null;
let running = false;
let framesSeen = 0;
let heartbeat = null;
let playback = null;
let recognitionWorker = null;
let recognitionTimer = null;
let modelLoadTimer = null;
let inferenceTimer = null;
let backend = 'helper';
let lookahead = null;
let modelThreads = 1;
let busy = false;
let ready = false;
let generation = 0;
let captureSession = 0;
let captureEpoch = 0;
let inFlightEpoch = 0;
let clockPending = false;
let inFlightAt = 0;
let lastClock = null;
let nextInferenceAt = 0;
const windowAudio = new AudioWindow(SAMPLE_RATE * 10);
const scheduler = new RecognitionScheduler(SAMPLE_RATE);

function resetRecognition(keepContext = false) {
  generation++;
  nextInferenceAt = 0;
  windowAudio.reset();
  scheduler.reset();
  recognitionWorker?.postMessage({ type: 'reset', keepContext });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
}

function connectBrowser(maxThreads = 4) {
  debug('Listening live · loading CPU model…');
  recognitionWorker = new Worker(new URL('../cpu/recognition-worker.js', import.meta.url), { type: 'module' });
  const fail = (error) => {
    stopCapture();
    send({ type: 'ERROR', error: `Browser recognition failed: ${error}` });
  };
  recognitionWorker.onerror = (e) => fail(e.message);
  modelLoadTimer = setTimeout(() => fail('CPU model loading timed out. Reload the extension and try again.'), 60000);
  recognitionWorker.onmessage = ({ data }) => {
    if (!running) return;
    if (data.type === 'ready') {
      clearTimeout(modelLoadTimer);
      modelLoadTimer = null;
      ready = true;
      modelThreads = data.threads || 1;
      send({ type: 'STATUS', status: 'listening' });
      debug(`Listening live · buffering audio · Quran ASR Small · ${modelThreads} thread(s) · 4s window / 0.5s hop`);
    } else if (data.type === 'progress') {
      send({ type: 'MODEL_PROGRESS', progress: data });
    } else if (data.type === 'error') {
      if (data.initializing && maxThreads > 1) {
        // Retry in a fresh worker: an initialized ORT runtime cannot safely
        // change its thread pool in place. Never interrupt the captured stream.
        clearTimeout(modelLoadTimer);
        clearInterval(recognitionTimer);
        recognitionWorker.terminate();
        debug('Threaded CPU initialization failed — retrying with one thread…');
        connectBrowser(1);
      } else fail(data.error);
    } else if (data.type === 'result') {
      clearTimeout(inferenceTimer);
      inferenceTimer = null;
      busy = false;
      if (data.generation !== generation) {
        nextInferenceAt = 0;
        return;
      }
      scheduler.updateTracking(data.tracking, data.ms, modelThreads);
      nextInferenceAt = performance.now() + recognitionCooldown(data.ms, scheduler.responsive);
      const heard = (data.text || '').replace(/\s+/g, ' ').slice(0, 32);
      debug(`ASR ${modelThreads}t · ${data.ms}ms · ${data.tracking?.phase || 'identifying'} · ${data.match?.ref || heard || 'no text'}`);
      const highlight = data.highlight ? { ...data.highlight,
        expiresAt: inFlightAt + 1000 - data.highlight.ageMs } : null;
      if (data.match) send({ type: 'RESULT', match: data.match, highlight, captureEpoch: inFlightEpoch });
      else send({ type: 'HIGHLIGHT', highlight, captureEpoch: inFlightEpoch });
    }
  };
  recognitionWorker.postMessage({ type: 'init', baseURL: chrome.runtime.getURL(''), maxThreads });
  recognitionTimer = setInterval(() => {
    if (!running || !ready || busy || performance.now() < nextInferenceAt) return;
    const reason = scheduler.due();
    if (!reason) return;
    const audio = windowAudio.snapshot(scheduler.windowSamples());
    const freshSeconds = scheduler.freshSeconds();
    inFlightAt = Date.now();
    inFlightEpoch = captureEpoch;
    scheduler.submittedNow();
    busy = true;
    debug(`ASR ${modelThreads}t · processing ${(audio.length / SAMPLE_RATE).toFixed(1)}s audio`);
    // Do not wait up to 1.5 seconds for a busy page before recognizing audio.
    // Explicit capture epochs reject pre-seek results independently of clocks.
    pollCaptureClock();
    armInferenceTimeout();
    recognitionWorker.postMessage({ type: 'audio', audio, generation, freshSeconds }, [audio.buffer]);
  }, 50); // Cheap checks; audio samples and measured CPU speed set the cadence.
}

function pollCaptureClock() {
  if (clockPending) return;
  clockPending = true;
  const submittedGeneration = generation;
  const session = captureSession;
  captureClock().then((clock) => {
    if (!running || session !== captureSession || submittedGeneration !== generation || !clock) return;
    const changed = lastClock && (clock.key !== lastClock.key || Math.abs(clock.duration - lastClock.duration) > 2);
    lastClock = clock;
    if (changed || clock.seeking) resetRecognition();
  }).finally(() => { clockPending = false; });
}

function armInferenceTimeout() {
  clearTimeout(inferenceTimer);
  inferenceTimer = setTimeout(() => {
    const error = 'CPU recognition stopped responding (45 seconds). Stop sync and try again, or use the helper mode.';
    // A stuck WASM call cannot be cancelled inside the worker. Terminate it
    // instead of leaving `busy` set forever or queueing more inference.
    stopCapture();
    send({ type: 'ERROR', error });
  }, 45000);
}

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
function debug(text) {
  if (DEV_MODE) console.log('[qlt]', text);
  send({ type: 'DEBUG', text });
}
// A slow tab or asleep service worker must not leave recognition stuck on `busy`.
function captureClock(ms = 1500) {
  let timer;
  return Promise.race([
    chrome.runtime.sendMessage({ type: 'CAPTURE_CLOCK' }).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function serverUnreachable() {
  send({
    type: 'ERROR',
    error: 'Local recognition server not reachable. Start it (server/run.bat), then click Start again.',
  });
}

// --- WebSocket to the local server ------------------------------------------
function connectServer() {
  send({ type: 'STATUS', status: 'loading-model' });
  debug('Connecting to local recognition server…');
  try {
    ws = new WebSocket(SERVER_URL);
  } catch {
    serverUnreachable();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => debug('Connected — waiting for the model…');
  ws.onmessage = (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.type === 'ready') {
      if (d.capabilities?.live === false) {
        send({ type: 'ERROR', error: 'The audio-only helper supports Browser CPU look-ahead. Start server.py for GPU live recognition.' });
        return;
      }
      send({ type: 'STATUS', status: 'listening' });
      debug('Server ready — listening for recitation.');
    } else if (d.type === 'result' && d.match) {
      send({ type: 'RESULT', match: d.match });
    }
  };
  ws.onerror = () => {
    if (running) serverUnreachable();
  };
  ws.onclose = () => {
    if (running) serverUnreachable();
  };
}

// --- Capture ----------------------------------------------------------------
async function startCapture(streamId, mode = 'helper', epoch = 0, reservedStream = null) {
  if (running) return;
  running = true;
  const session = ++captureSession;
  backend = mode;
  captureEpoch = epoch;
  lastClock = null;
  resetRecognition();
  send({ type: 'STATUS', status: 'loading-model' });
  playback = document.getElementById('playback');

  try {
    const captured = reservedStream || await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    if (!running || session !== captureSession) {
      captured.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStream = captured;
  } catch (err) {
    if (session !== captureSession) return;
    stopCapture();
    send({ type: 'ERROR', error: `Capture failed: ${err?.message || err}` });
    return;
  }

  // Keep the tab audible.
  playback.srcObject = mediaStream;
  playback.play().catch(() => {});

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await audioContext.resume(); // offscreen has no gesture; context can start suspended
  } catch {}

  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL('worklet/capture-worklet.js'),
  );
  if (!running || session !== captureSession) return;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'qlt-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  workletNode.port.onmessage = (e) => {
    if (!running) return;
    framesSeen++;
    if (backend === 'browser') {
      windowAudio.push(e.data);
      scheduler.push(e.data);
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(e.data.buffer); // Float32 PCM, transferred from the worklet
    }
  };

  const silent = audioContext.createGain();
  silent.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silent);
  silent.connect(audioContext.destination); // pulls the graph; worklet outputs silence

  mediaStream.getAudioTracks().forEach((t) => {
    t.addEventListener('ended', () => stopCapture());
  });

  running = true;
  framesSeen = 0;
  if (backend === 'browser') connectBrowser();
  else connectServer();

  clearInterval(heartbeat);
  let lastFrames = 0;
  heartbeat = setInterval(() => {
    if (!running) return;
    if (framesSeen === lastFrames) {
      debug('No audio frames — is the tab actually playing sound (not muted)?');
    }
    lastFrames = framesSeen;
  }, 5000);
}

function stopCapture() {
  const cleanup = lookahead?.stop();
  lookahead = null;
  running = false;
  captureSession++;
  clearTimeout(modelLoadTimer);
  modelLoadTimer = null;
  clearTimeout(inferenceTimer);
  inferenceTimer = null;
  generation++;
  clearInterval(recognitionTimer);
  recognitionTimer = null;
  recognitionWorker?.terminate();
  recognitionWorker = null;
  ready = busy = false;
  windowAudio.reset();
  clearInterval(heartbeat);
  heartbeat = null;
  try {
    ws && ws.close();
  } catch {}
  ws = null;
  try {
    workletNode?.disconnect();
    sourceNode?.disconnect();
  } catch {}
  try {
    audioContext?.close();
  } catch {}
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (playback) playback.srcObject = null;
  audioContext = mediaStream = sourceNode = workletNode = null;
  send({ type: 'STATUS', status: 'stopped' });
  return cleanup;
}

// --- Message routing --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.backend, msg.captureEpoch).catch((err) => {
        stopCapture();
        send({ type: 'ERROR', error: err.message || String(err) });
      });
      sendResponse?.({ ok: true });
      break;
    case 'START_LOOKAHEAD':
      (async () => {
        if (running) return;
        running = true;
        backend = 'lookahead';
        captureEpoch = msg.captureEpoch;
        const session = ++captureSession;
        if (msg.streamId) {
          try {
            const captured = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } }, video: false,
            });
            if (!running || session !== captureSession) { captured.getTracks().forEach((t) => t.stop()); return; }
            mediaStream = captured;
            playback = document.getElementById('playback');
            playback.srcObject = captured;
            playback.play().catch(() => {});
          } catch {} // Browser downloading itself does not require tab capture.
        }
        const { startLookahead } = await import('../cpu/lookahead.js');
        if (!running || session !== captureSession) return;
        const fallback = async () => {
          if (!running || session !== captureSession) return;
          const result = await chrome.runtime.sendMessage({ type: 'CPU_LIVE_FALLBACK', hasStream: !!mediaStream?.active });
          if (!running || session !== captureSession || result?.cancelled) return;
          if (!result?.ok) {
            stopCapture();
            send({ type: 'ERROR', error: result?.error || 'Could not start CPU live listening.' });
            return;
          }
          lookahead = null;
          const captured = mediaStream?.active ? mediaStream : null;
          running = false;
          await startCapture(result.streamId, 'browser', captureEpoch, captured);
        };
        lookahead = startLookahead({ ...msg, onUnavailable: msg.youtubeId || msg.directMedia ? fallback : null }, (message) => {
          if (message.type === 'CPU_AUDIO_SOURCE' && mediaStream) {
            // A completed download no longer needs the preparation fallback.
            mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null;
            if (playback) playback.srcObject = null;
          }
          send(message);
        });
      })().catch((error) => {
        stopCapture();
        send({ type: 'ERROR', error: error.message || String(error) });
      });
      sendResponse?.({ ok: true });
      break;
    case 'STOP_CAPTURE':
      // Keep the offscreen document alive until its private disk cache and
      // sandbox network session are gone; teardown closes the document next.
      Promise.resolve(stopCapture()).then(() => sendResponse?.({ ok: true }), () => sendResponse?.({ ok: true }));
      break;
    case 'CPU_HIGHLIGHT_SETTING':
      lookahead?.setHighlight(msg.enabled);
      sendResponse?.({ ok: true });
      break;
    case 'RESET_CAPTURE':
      if (msg.captureEpoch != null) captureEpoch = msg.captureEpoch;
      if (lookahead) {
        lookahead.reset(msg.captureEpoch, msg.time);
        sendResponse?.({ ok: true });
        break;
      }
      resetRecognition();
      sendResponse?.({ ok: true });
      break;
  }
  return true;
});
