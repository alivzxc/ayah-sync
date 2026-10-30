import { YOUTUBE_LIMITS, youtubeRequest, boundedYoutubeBody } from './youtube-policy.js';
import { BatchedAudioSource } from './audio-batches.js';
import { createAudioBatchStore } from './audio-batch-store.js';
import { openAudioBatch as openYoutubeBatch } from './audio-batch-decoder.js';
export { openYoutubeBatch, createAudioBatchStore };

// Native decoding is outside the untrusted sandbox, but inside the existing CPU
// offscreen document. No models, recognition state or Chrome APIs enter the frame.
export async function decodeYoutubeAudio(bytes, duration, signal) {
  signal.throwIfAborted();
  if (!Number.isFinite(duration) || duration <= 0 || duration > YOUTUBE_LIMITS.batchSeconds + YOUTUBE_LIMITS.batchPadding) {
    throw new Error('Invalid or oversized native audio decode');
  }
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await context.decodeAudioData(bytes);
    signal.throwIfAborted();
    if (decoded.sampleRate !== 16000 || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 ||
        decoded.duration > YOUTUBE_LIMITS.batchSeconds + YOUTUBE_LIMITS.batchPadding || Math.abs(decoded.duration - duration) > 2 || !decoded.length) {
      throw new Error('Downloaded audio does not match the current video or exceeds the browser limit');
    }
    let pcm = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < pcm.length; i++) pcm[i] += channel[i] / decoded.numberOfChannels;
    }
    return { duration: decoded.duration, sampleRate: 16000,
      window(start) {
        if (!pcm) throw new Error('YouTube audio source is closed');
        const offset = Math.max(0, Math.floor(start * 16000));
        return { start: offset / 16000, sampleRate: 16000, audio: pcm.slice(offset, offset + 20 * 16000) };
      }, close() { pcm = null; } };
  } finally { await context.close().catch(() => {}); }
}

export async function prepareYoutubeAudio({ videoId, expectedDuration, position = 0, signal, onProgress = () => {} }) {
  if (!/^[\w-]{11}$/.test(videoId) || !(expectedDuration > 0) || expectedDuration > YOUTUBE_LIMITS.seconds) {
    throw new Error('YouTube browser downloading supports prerecorded videos up to 10 hours');
  }
  signal.throwIfAborted();
  const store = await createAudioBatchStore();
  let source;
  try {
    source = new BatchedAudioSource({ duration: expectedDuration, position, signal, store, onProgress,
      download: (range) => downloadYoutubeRange({ videoId, expectedDuration, ...range }), open: openYoutubeBatch });
    return await source.prepare();
  } catch (error) { if (source) await source.close(); else await store.close(); throw error; }
}

export async function downloadYoutubeRange({ videoId, expectedDuration, start, end, signal, onProgress = () => {} }) {
  signal.throwIfAborted();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > expectedDuration ||
      end - start > YOUTUBE_LIMITS.batchSeconds) throw new Error('Invalid YouTube audio batch');
  // Segment-aligned overlap keeps cross-batch recognition windows continuous.
  const rangeStart = Math.max(0, start - 3), rangeEnd = Math.min(expectedDuration, end + 3);
  const network = new AbortController();
  const sessionId = crypto.randomUUID();
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'");
  iframe.src = chrome.runtime.getURL('src/cpu/youtube-sandbox.html');
  const channel = new MessageChannel();
  const active = new Map();
  let requests = 0, size = 0, duration = null, total = 0, settled = false;
  let first = Infinity, until = -Infinity;
  let rejectDownload, readyTimer, deadline;
  const chunks = [];

  const reply = (message, transfer = []) => { if (!settled) channel.port1.postMessage(message, transfer); };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    network.abort();
    rejectDownload(error);
  };
  const aborted = () => fail(new DOMException('Stopped', 'AbortError'));
  const ready = (event) => {
    if (event.source !== iframe.contentWindow || event.data?.type !== 'YOUTUBE_READY') return;
    clearTimeout(readyTimer);
    window.removeEventListener('message', ready);
    iframe.contentWindow.postMessage({ type: 'YOUTUBE_START', videoId, start: rangeStart, end: rangeEnd }, '*', [channel.port2]);
  };

  async function fetchRequest(data) {
    let controller;
    try {
      if (++requests > YOUTUBE_LIMITS.requests) {
        fail(new Error('Too many YouTube network requests')); return;
      }
      if (active.size >= 8 || !Number.isSafeInteger(data.id) || active.has(data.id)) {
        throw new Error('Too many YouTube requests');
      }
      let request = youtubeRequest(data);
      controller = new AbortController();
      active.set(data.id, controller);
      const requestSignal = AbortSignal.any([network.signal, controller.signal, AbortSignal.timeout(20000)]);
      let response;
      for (let redirects = 0; redirects < 4; redirects++) {
        response = await fetch(request.url, { method: request.method, headers: request.headers,
          body: request.body, credentials: 'include', redirect: 'manual', signal: requestSignal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error('YouTube redirect denied');
        request = youtubeRequest({ ...data, url: new URL(location, request.url).href,
          method: response.status === 303 ? 'GET' : request.method,
          body: response.status === 303 ? null : request.body });
      }
      const body = await boundedYoutubeBody(response, requestSignal);
      reply({ type: 'FETCH_RESULT', id: data.id, status: response.status, url: response.url,
        headers: [...response.headers].filter(([name]) => ['content-type', 'content-length', 'content-range'].includes(name)), body }, [body]);
    } catch {
      // Do not expose exception strings containing URLs/cookies/player tokens.
      reply({ type: 'FETCH_ERROR', id: data.id });
    } finally { if (active.get(data.id) === controller) active.delete(data.id); }
  }

  try {
    // Only requests from this extension get the YouTube Origin/Referer headers.
    // The sandbox itself cannot install rules or choose arbitrary endpoints.
    const enabled = await chrome.runtime.sendMessage({ type: 'CPU_YT_NETWORK', enabled: true, sessionId });
    if (!enabled?.ok) throw new Error('Could not enable the CPU YouTube network bridge');
    const compressed = await new Promise((resolve, reject) => {
      rejectDownload = reject;
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      readyTimer = setTimeout(() => fail(new Error('YouTube.js sandbox did not start')), 15000);
      deadline = setTimeout(() => fail(new Error('YouTube.js audio batch timed out')), end - start <= 180 ? 120000 : 300000);
      channel.port1.onmessage = ({ data }) => {
        if (settled) return;
        if (data?.type === 'FETCH') { fetchRequest(data); return; }
        if (data?.type === 'FETCH_CANCEL') { active.get(data.id)?.abort(); return; }
        if (data?.type === 'RESET_AUDIO') {
          chunks.length = 0; size = 0; duration = null; total = 0; first = Infinity; until = -Infinity;
        } else if (data?.type === 'PROGRESS') {
          if (['session', 'attestation', 'download'].includes(data.stage)) onProgress({ stage: data.stage, received: size, total });
        } else if (data?.type === 'META') {
          if (!Number.isFinite(data.duration) || Math.abs(data.duration - expectedDuration) > 2 || data.duration > YOUTUBE_LIMITS.seconds ||
              !Number.isFinite(data.total) || data.total < 0 || data.total > YOUTUBE_LIMITS.audioBytes) {
            fail(new Error('Invalid or oversized YouTube audio metadata')); return;
          }
          duration = data.duration; total = data.total;
        } else if (data?.type === 'AUDIO') {
          if (duration === null || !(data.bytes instanceof ArrayBuffer) || !data.bytes.byteLength ||
              size + data.bytes.byteLength > YOUTUBE_LIMITS.audioBytes) {
            fail(new Error('Invalid or oversized YouTube audio')); return;
          }
          chunks.push(new Uint8Array(data.bytes)); size += data.bytes.byteLength;
          if (!data.init) {
            if (!Number.isFinite(data.start) || !Number.isFinite(data.end) || data.start < 0 || data.end <= data.start ||
                data.end > expectedDuration + 2 || (until > 0 && data.start > until + 0.15)) {
              fail(new Error('Invalid or discontinuous YouTube audio segment')); return;
            }
            first = Math.min(first, data.start); until = Math.max(until, data.end);
          }
          onProgress({ stage: 'download', received: size, total });
        } else if (data?.type === 'DONE') {
          if (!size || duration === null || first > start + 0.1 || until < end - 0.1 ||
              until - first > end - start + YOUTUBE_LIMITS.batchPadding) { fail(new Error('YouTube returned an incomplete audio batch')); return; }
          settled = true;
          resolve(new Blob(chunks));
        } else if (data?.type === 'FAILED') fail(new Error('YouTube.js could not download this video; playback attestation or browser restrictions may be blocking it'));
      };
      window.addEventListener('message', ready);
      document.body.appendChild(iframe);
    });
    signal.throwIfAborted();
    onProgress({ stage: 'decode', received: size, total });
    return { blob: compressed, start: first, end: until };
  } finally {
    settled = true;
    clearTimeout(readyTimer); clearTimeout(deadline);
    signal.removeEventListener('abort', aborted);
    window.removeEventListener('message', ready);
    channel.port1.postMessage({ type: 'CANCEL' });
    channel.port1.close(); channel.port2.close();
    network.abort();
    iframe.remove(); chunks.length = 0;
    await chrome.runtime.sendMessage({ type: 'CPU_YT_NETWORK', enabled: false, sessionId }).catch(() => {});
  }
}
