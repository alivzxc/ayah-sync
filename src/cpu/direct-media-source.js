import { Input, CustomSource, MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC,
  EncodedPacketSink, EncodedAudioPacketSource, Output, MkvOutputFormat, StreamTarget } from 'mediabunny';
import { BatchedAudioSource, MAX_VIDEO_SECONDS } from './audio-batches.js';
import { createAudioBatchStore } from './audio-batch-store.js';
import { openAudioBatch } from './audio-batch-decoder.js';
import { DIRECT_MEDIA_LIMITS as LIMITS, directMediaURL, mediaContentRange, mediaRangeBody } from './direct-media-policy.js';

// This fetcher is bound to one selected media URL/origin. It cannot be used as
// an arbitrary content-script proxy, and never installs YouTube header rules.
export function createMediaRangeReader({ url, signal, credentials = 'omit', identity = null, fetcher = fetch }) {
  let current = directMediaURL(url), size = null, requests = 0, received = 0, validator = null;
  let budget = LIMITS.readBytes; // Metadata/seeking must not scan a whole long file.
  const origin = current.origin;
  async function range(start, end) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
        end - start + 1 > LIMITS.responseBytes || ++requests > LIMITS.requests ||
        received + end - start + 1 > budget) throw new Error('Media range download limit exceeded');
    received += end - start + 1;
    let response;
    for (let redirects = 0; redirects < 4; redirects++) {
      response = await fetcher(current.href, { method: 'GET', headers: { Range: `bytes=${start}-${end}` },
        credentials: credentials === 'include' ? 'include' : 'omit', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Media redirect could not be followed safely');
      const next = directMediaURL(new URL(location, current).href);
      if (next.origin !== origin) throw new Error('Media redirects to another origin; use the audio helper or live listening');
      current = next;
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error('Media server denied byte ranges or browser access');
    }
    try {
      const total = mediaContentRange(response.headers.get('content-range'), start, end, size);
      const version = response.headers.get('etag') || response.headers.get('last-modified');
      if ((validator && version !== validator) || (identity && (identity.size !== total || identity.validator !== version))) {
        throw new Error('Media file changed during this session');
      }
      size = total; validator = version;
      const bytes = await mediaRangeBody(response, end - start + 1, signal);
      return bytes;
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  }
  return {
    async probe() { await range(0, 0); return { size, validator }; },
    getSize() { if (size === null) throw new Error('Media was not probed'); return size; },
    beginAudio() { budget = LIMITS.networkBytes; },
    async read(start, end) {
      if (end - start > LIMITS.readBytes) throw new Error('Media metadata read is too large');
      const bytes = new Uint8Array(end - start);
      for (let at = start; at < end; at += LIMITS.responseBytes) {
        const part = await range(at, Math.min(end, at + LIMITS.responseBytes) - 1);
        bytes.set(part, at - start);
      }
      return bytes;
    },
  };
}

async function downloadDirectRange({ url, expectedDuration, credentials, identity, setIdentity, start, end, phase, signal, onProgress }) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(phase === 'background' ? 300000 : 120000)]);
  onProgress({ stage: 'session' });
  const reader = createMediaRangeReader({ url, signal, credentials, identity });
  const version = await reader.probe(); setIdentity(version);
  const input = new Input({ formats: [MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC],
    source: new CustomSource({ getSize: () => reader.getSize(), read: (from, until) => reader.read(from, until),
      maxCacheSize: 2 * 1024 * 1024, prefetchProfile: 'fileSystem', handleUnhandledError() {} }) });
  let output = null;
  const aborted = () => input.dispose();
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode()) || await track.getNumberOfChannels() > 2) throw new Error('No supported unprotected audio track');
    const duration = await input.getDurationFromMetadata();
    if (duration !== null && (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 2)) {
      throw new Error('Media duration does not match the selected player');
    }
    const codec = await track.getCodec(), format = new MkvOutputFormat({ appendOnly: true });
    if (!codec || !format.getSupportedAudioCodecs().includes(codec)) throw new Error('Unsupported direct audio codec');
    const sink = new EncodedPacketSink(track), chunks = [];
    let size = 0, first = null, until = null;
    const target = new StreamTarget(new WritableStream({ write({ data, position }) {
      if (position !== size || size + data.length > LIMITS.audioBytes) throw new Error('Direct audio batch exceeds its cache limit');
      chunks.push(data.slice()); size += data.length;
    } }), { chunked: true, chunkSize: 256 * 1024 });
    output = new Output({ format, target });
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('Audio decoder configuration is missing');
    await output.start();
    const from = Math.max(0, start - 0.1), to = Math.min(expectedDuration, end + 0.1);
    const firstPacket = await sink.getKeyPacket(from) || await sink.getFirstPacket();
    if (!firstPacket || firstPacket.timestamp > start + 0.15 || firstPacket.timestamp < from - 2) {
      throw new Error('Media cannot seek efficiently to the requested audio position');
    }
    reader.beginAudio();
    onProgress({ stage: 'download', received: 0, total: end - start });
    for await (const packet of sink.packets(firstPacket)) {
      signal.throwIfAborted();
      // Matroska/WebM may omit packet duration (the parser reports zero).
      // Keep those packets; timestamps and the decoded batch still bound coverage.
      if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration < 0 ||
          packet.byteLength > 4 * 1024 * 1024) throw new Error('Invalid audio packet');
      if (packet.timestamp >= to) break;
      first ??= packet.timestamp;
      until = packet.timestamp + packet.duration;
      if (until - first > end - start + 5) throw new Error('Direct audio batch duration exceeded its limit');
      await source.add(packet.clone({ timestamp: packet.timestamp - first }), { decoderConfig });
      onProgress({ stage: 'download', received: Math.max(0, Math.min(end - start, until - start)), total: end - start });
      if (until >= to) break;
    }
    if (first === null || until < end - 0.15) throw new Error('Media ended before the requested audio batch');
    source.close();
    await output.finalize(); signal.throwIfAborted();
    onProgress({ stage: 'decode' });
    return { blob: new Blob(chunks, { type: 'audio/x-matroska' }), start: first, end: until };
  } finally {
    signal.removeEventListener('abort', aborted);
    input.dispose();
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
  }
}

export async function prepareDirectMedia({ url, expectedDuration, position = 0, credentials = 'omit', signal, onProgress = () => {} }) {
  const media = directMediaURL(url);
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || expectedDuration > MAX_VIDEO_SECONDS) {
    throw new Error('Direct CPU audio supports finite media up to 10 hours');
  }
  signal.throwIfAborted();
  const store = await createAudioBatchStore();
  let source = null, identity = null;
  try {
    source = new BatchedAudioSource({ duration: expectedDuration, position, signal, store, onProgress, open: openAudioBatch,
      async download(range) {
        try { return await downloadDirectRange({ url: media.href, expectedDuration, credentials, identity,
          setIdentity(value) { identity ??= value; }, ...range }); }
        catch (error) {
          if (range.signal.aborted) throw range.signal.reason;
          throw new Error('Direct media range could not be prepared (access, seek support, codec, or file limits)');
        }
      } });
    return await source.prepare();
  } catch (error) {
    if (source) await source.close(); else await store.close();
    // Parser/network exceptions can contain signed media URLs. Keep UI safe.
    if (signal.aborted) throw signal.reason;
    throw new Error('Direct media downloading is unavailable (access, range support, codec, or file limits)');
  }
}
