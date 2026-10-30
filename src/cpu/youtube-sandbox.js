// Only this opaque-origin sandbox evaluates player/challenge code. It has no
// chrome APIs and no direct network access; all requests pass a parent allowlist.
import { Innertube, Platform, Log, Constants } from 'youtubei.js/web';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes, Logger, LogLevel, base64ToU8 } from 'googlevideo/utils';
import { BotGuardClient, parseChallengeData } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, GOOG_API_KEY } from 'bgutils-js/utils';
import { YOUTUBE_LIMITS } from './youtube-policy.js';

Log.setLevel(Log.Level.NONE);
Logger.getInstance().setLogLevels(LogLevel.NONE);
Platform.shim.eval = async (data) => new Function(data.output)();
let port, stream, botguard, script, cancelled = false, requestId = 0;
const pending = new Map();
const send = (message, transfer = []) => { if (!cancelled) port.postMessage(message, transfer); };

async function proxyFetch(input, init = {}) {
  const request = new Request(input, init);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  if (cancelled || request.signal.aborted) throw new DOMException('Stopped', 'AbortError');
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const abort = () => {
      pending.delete(id);
      send({ type: 'FETCH_CANCEL', id });
      reject(new DOMException('Stopped', 'AbortError'));
    };
    request.signal.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, cleanup: () => request.signal.removeEventListener('abort', abort) });
    send({ type: 'FETCH', id, url: request.url, method: request.method, headers: [...request.headers], body }, body ? [body] : []);
  });
}

async function mintToken(videoId) {
  const key = 'O43z0dpjhgX20SCx4KAo';
  const headers = { 'content-type': 'application/json+protobuf', 'x-goog-api-key': GOOG_API_KEY,
    'x-user-agent': 'grpc-web-javascript/0.1' };
  const challenge = await proxyFetch(buildURL('Create', true), { method: 'POST', headers, body: JSON.stringify([key]) });
  if (!challenge.ok) throw new Error('YouTube attestation challenge was rejected');
  const data = parseChallengeData(await challenge.json());
  const javascript = data?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!javascript) throw new Error('YouTube attestation interpreter is unavailable');
  script = document.createElement('script');
  script.textContent = javascript;
  document.head.appendChild(script);
  botguard = await BotGuardClient.create({ globalObject: globalThis, globalName: data.globalName, program: data.program });
  const webPoSignalOutput = [];
  const snapshot = await botguard.snapshot({ webPoSignalOutput });
  const response = await proxyFetch(buildURL('GenerateIT', true), { method: 'POST', headers, body: JSON.stringify([key, snapshot]) });
  if (!response.ok) throw new Error('YouTube attestation token was rejected');
  const [integrityToken] = await response.json();
  if (!integrityToken) throw new Error('YouTube did not provide an attestation token');
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  return minter.mintAsWebsafeString(videoId);
}

async function download(videoId, range) {
  send({ type: 'PROGRESS', stage: 'session' });
  // This is the browser entry point/custom fetch pattern from ytjs.dev. No
  // handwritten player-response extraction, signatures, manifests, or UMP parser.
  const yt = await Innertube.create({ fetch: proxyFetch, enable_session_cache: false, fail_fast: true });
  // The current upstream browser example uses VISIONOS; WEB is retained as a
  // library-managed fallback. Web PO tokens must never be sent to other clients.
  for (const client of ['VISIONOS', 'WEB']) {
    try { await downloadClient(yt, videoId, client, range); return; }
    catch (error) {
      cleanup();
      if (cancelled) throw error;
      send({ type: 'RESET_AUDIO' });
    }
  }
  throw new Error('YouTube download clients were unavailable');
}

async function downloadClient(yt, videoId, client, range) {
  const info = await yt.getBasicInfo(videoId, { client });
  if (info.playability_status?.status !== 'OK') throw new Error('YouTube cannot play this video in the download session');
  if (info.basic_info.id !== videoId || info.basic_info.is_live || info.basic_info.is_post_live_dvr) throw new Error('Use live listening for this stream');
  const duration = Number(info.basic_info.duration);
  if (!(duration > 0) || duration > YOUTUBE_LIMITS.seconds) throw new Error('Browser audio supports videos up to 10 hours');
  const originals = (info.streaming_data?.adaptive_formats || []).filter((f) => f.has_audio && !f.has_video &&
    !f.drm_families?.length && !f.drm_track_type && (f.audio_channels || 1) <= 2);
  const formats = originals.map(buildSabrFormat);
  const audio = formats.filter((f) => f.isOriginal && !f.isDrc).sort((a, b) =>
    Number(b.mimeType?.includes('mp4')) - Number(a.mimeType?.includes('mp4')) || a.bitrate - b.bitrate)[0];
  if (!audio) throw new Error('No supported browser audio format was found');
  send({ type: 'META', duration, total: Math.ceil((audio.contentLength || audio.bitrate * duration / 8 || 0) * (range.end - range.start) / duration) });
  const sabrURL = info.streaming_data?.server_abr_streaming_url;
  if (sabrURL) {
    let token;
    if (client === 'WEB') {
      send({ type: 'PROGRESS', stage: 'attestation' });
      token = await mintToken(videoId);
    }
    if (cancelled) return;
    const url = await yt.session.player.decipher(sabrURL);
    const config = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (!config || !url) throw new Error('YouTube did not provide SABR streaming configuration');
    stream = new SabrStream({ videoId, formats, serverAbrStreamingUrl: url, videoPlaybackUstreamerConfig: config,
      fetchFunction: proxyFetch, poToken: token,
      clientInfo: { clientName: Number(Constants.CLIENT_NAME_IDS[client]),
        clientVersion: client === 'WEB' ? yt.session.context.client.clientVersion : Constants.CLIENTS.VISIONOS.VERSION,
        ...(client === 'VISIONOS' ? { osName: Constants.CLIENTS.VISIONOS.OS_NAME, osVersion: Constants.CLIENTS.VISIONOS.OS_VERSION,
          deviceMake: Constants.CLIENTS.VISIONOS.DEVICE_MAKE, deviceModel: Constants.CLIENTS.VISIONOS.DEVICE_MODEL } : {}) },
      callbacks: token ? { onMintPoToken: async () => base64ToU8(token) } : {} });
    let pendingAttestation = 0;
    stream.on('streamProtectionStatusUpdate', (status) => {
      if (status.status === 3 || (status.status === 2 && ++pendingAttestation >= 6)) stream.abort().catch(() => {});
    });
    let track;
    const metadata = [], seen = new Set();
    const collect = (audioTrack) => {
      track = audioTrack;
      for (const [id, segment] of audioTrack.trackedSegments) if (!seen.has(id)) { seen.add(id); metadata.push(segment); }
    };
    stream.on('formatInitialization', (value) => { if (value.type === 'audio') track = value; });
    stream.on('trackStateUpdate', (tracks) => collect(tracks.audio));
    const { audioStream } = stream.start({ audioFormat: audio, enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY, startTimeMs: Math.floor(range.start * 1000),
      isPostLiveDvr: false, maxRetries: 1, stallDetectionMs: 8000 });
    await consume(audioStream, range, () => { if (track) collect(track); return metadata.shift(); });
  } else {
    // YouTube.js legacy downloads expose byte ranges, not bounded time ranges.
    // Never silently download a ten-hour file to satisfy a three-minute request.
    throw new Error('Time-bounded audio requires SABR');
  }
}

async function consume(audioStream, range, nextMetadata) {
  send({ type: 'PROGRESS', stage: 'download' });
  const reader = audioStream.getReader();
  let size = 0;
  try {
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      size += bytes.length;
      if (size > YOUTUBE_LIMITS.audioBytes) throw new Error('Browser audio batch exceeds 64 MiB');
      const segment = nextMetadata();
      if (!segment) throw new Error('SABR audio segment metadata is unavailable');
      send({ type: 'AUDIO', bytes: bytes.buffer, init: !!segment.mediaHeader.isInitializationSegment,
        start: segment.startTimeMs / 1000, end: segment.endTimeMs / 1000 }, [bytes.buffer]);
      if (!segment.mediaHeader.isInitializationSegment && segment.endTimeMs >= range.end * 1000 - 1) break;
    }
    if (!cancelled && !size) throw new Error('YouTube returned no audio');
    if (!cancelled) send({ type: 'DONE' });
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function cleanup() {
  try { botguard?.shutdown(); } catch {}
  botguard = null;
  script?.remove(); script = null;
  stream?.abort().catch(() => {}); stream = null;
}

window.addEventListener('message', (event) => {
  if (event.source !== parent || port || event.data?.type !== 'YOUTUBE_START' || !event.ports[0] ||
      !/^[\w-]{11}$/.test(event.data.videoId || '')) return;
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (data.type === 'CANCEL') {
      cancelled = true;
      for (const request of pending.values()) { request.cleanup(); request.reject(new Error('Stopped')); }
      pending.clear(); cleanup(); return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id); request.cleanup();
    if (data.type === 'FETCH_ERROR') request.reject(new Error('YouTube network request failed'));
    else if (data.type === 'FETCH_RESULT') {
      try {
        const response = new Response([204, 205, 304].includes(data.status) ? null : data.body,
          { status: data.status, headers: data.headers });
        Object.defineProperty(response, 'url', { value: data.url });
        request.resolve(response);
      } catch (error) { request.reject(error); }
    }
  };
  const { start, end } = event.data;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
      end > YOUTUBE_LIMITS.seconds || end - start > YOUTUBE_LIMITS.batchSeconds + 6) return;
  download(event.data.videoId, { start, end }).catch(() => {
    // Library exceptions can contain signed URLs/tokens: never forward them.
    send({ type: 'FAILED', error: 'YouTube.js could not download this video (playback, attestation, or browser restriction).' });
  }).finally(cleanup);
});

parent.postMessage({ type: 'YOUTUBE_READY' }, '*');
