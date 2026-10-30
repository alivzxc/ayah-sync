import { Input, BlobSource, MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC, AudioBufferSink } from 'mediabunny';
import { YOUTUBE_LIMITS } from './youtube-policy.js';

// Demux partial containers with a maintained library. Decode only the requested
// seconds with WebCodecs, not an entire 30-minute batch or a video-long buffer.
export async function openAudioBatch(blob, metadata, signal) {
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(blob, { maxCacheSize: 2 * 1024 * 1024 }),
    formats: [MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC] });
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the downloaded audio codec');
    const channels = await track.getNumberOfChannels(), sampleRate = await track.getSampleRate();
    const first = await track.getFirstTimestamp(), end = await track.computeDuration();
    if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000 ||
        !Number.isFinite(first) || !Number.isFinite(end) || end <= first || end - first > YOUTUBE_LIMITS.batchSeconds + YOUTUBE_LIMITS.batchPadding ||
        Math.abs(end - first - (metadata.end - metadata.start)) > 1) {
      throw new Error('Downloaded audio batch timestamps do not match its segments');
    }
    // Containers may retain absolute decode times or normalize to zero. Source
    // metadata anchors either representation on the video's clock.
    const shift = metadata.start - first;
    const sink = new AudioBufferSink(track);
    return {
      async read(start, end, requestSignal) {
        requestSignal.throwIfAborted();
        let mono = null, samples = null, rate = null, length = 0, covered = 0;
        for await (const { buffer, timestamp } of sink.buffers(start - shift, end - shift)) {
          requestSignal.throwIfAborted();
          // HE-AAC/SBR can decode at twice the declared container sample rate.
          // Use the actual output rate rather than stretching/truncating it.
          if (!mono) {
            rate = buffer.sampleRate;
            if (rate < 8000 || rate > 96000) throw new Error('Unsupported decoded audio sample rate');
            length = Math.round((end - start) * rate);
            mono = new AudioBuffer({ numberOfChannels: 1, length, sampleRate: rate });
            samples = mono.getChannelData(0);
          }
          if (buffer.sampleRate !== rate || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
            throw new Error('Audio format changed inside a batch');
          }
          const offset = Math.round((timestamp + shift - start) * rate);
          const from = Math.max(0, -offset), until = Math.min(buffer.length, length - offset);
          if (until <= from) continue;
          covered += until - from;
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = from; i < until; i++) samples[offset + i] += data[i] / buffer.numberOfChannels;
          }
        }
        requestSignal.throwIfAborted();
        if (!mono || covered < length - rate * 0.15) throw new Error('Downloaded audio batch has a gap at the requested position');
        const context = new OfflineAudioContext(1, Math.round((end - start) * 16000), 16000);
        const node = context.createBufferSource(); node.buffer = mono; node.connect(context.destination); node.start();
        const rendered = await context.startRendering();
        requestSignal.throwIfAborted();
        return rendered.getChannelData(0).slice();
      },
      close() { input.dispose(); },
    };
  } catch (error) { input.dispose(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
