# YouTube.js CPU integration

CPU look-ahead tries YouTube.js first for finite YouTube videos up to 10 hours.
It does not replace the page's video player or affect the GPU pipeline. Other
sites retain the existing helper/live implementation.

## Library roles

- `youtubei.js/web` 18.3.0 creates the session, parses video information and handles
  player/signature logic. Non-SABR downloads fall back rather than fetching an
  unbounded full file to satisfy a short time-range request.
- `googlevideo` 5.0.1 `SabrStream` handles audio-only SABR/UMP downloads.
- `bgutils-js` 4.0.3 handles the BotGuard challenge and content-bound PO token.
- `mediabunny` 1.62.1 demuxes independent MP4/WebM batches and decodes short
  windows through native WebCodecs. No custom MP4/WebM parser is implemented.
- Our adapter provides the extension fetch bridge, lifecycle, limits and native
  audio decoding. It is not another YouTube extractor.

This follows [YouTube.js browser usage](https://ytjs.dev/guide/browser-usage.html),
specifically its browser import and custom `fetch` hook. That page explicitly
marks its DASH playback example outdated and directs users to
[the SABR/Shaka example](https://github.com/LuanRT/googlevideo/tree/main/examples/sabr-shaka-example)
and [Kira](https://github.com/LuanRT/kira). We use the same libraries' downloader
API, not an additional Shaka player or an external proxy server.
The library's VISIONOS client is tried first, following the current upstream
browser example, then WEB. WEB attestation tokens are used only with WEB;
SABR client metadata matches the selected client.

## MV3 and the network boundary

The libraries require player/challenge JavaScript evaluation. That runs only in
`src/cpu/youtube-sandbox.html`, declared as a sandboxed extension page with an
opaque origin. It cannot read the parent DOM or call extension APIs. Its CSP
denies direct network access and child frames. The recognizer and privileged
extension documents do **not** gain `unsafe-eval` or remote script sources.

A private MessagePort carries fetch requests to the CPU offscreen document.
Only HTTPS YouTube session/player/challenge endpoints and Google Video media
endpoints are allowed. Account mutation, OAuth, arbitrary destinations, custom
cookies and Authorization headers are denied. Redirects are checked again.
Requests, concurrent fetches, bodies, responses, download duration and retained
audio have explicit limits. Error messages are sanitized rather than forwarding
library exceptions that might contain signed URLs or tokens.

While downloading, a session DNR rule adds YouTube Origin/Referer headers only
for requests initiated by **this extension** to YouTube/Google Video. It does
not rewrite the user's tab traffic. The rule is removed on success, failure or
Stop, with teardown cleanup as a backup. Host permissions are limited to these
services and the existing loopback helper. Browser-managed credentials can be
included; no cookie-reading API is requested.

Stop aborts network requests, closes the message port, removes the sandbox,
releases downloaded PCM and terminates recognition. The offscreen Stop response
waits for its private compressed-audio disk cache to be removed before the
document is closed. Sessions/tokens are not
cached to extension storage. The sandbox may execute Google's downloaded
interpreter, so publishing this integration requires a separate Chrome Web Store
security/policy review; no store-compliance guarantee is implied.

## Limits and fallback

This is experimental. Correct library integration does not guarantee that
YouTube will accept a browser download session or its attestation. The source
falls back to an already-available local audio helper; if preparation still
fails, it switches to live browser CPU listening. If Chrome could not reserve a
capture stream, the user may need to reopen the popup and select live-only.

The video-duration limit is ten hours, not the amount downloaded or decoded at
startup. The first logical range is 180 seconds from ten seconds before the
starting playhead (clipped at zero/EOF). It immediately enables model loading
and the existing twelve-second recognition/display gate. Remaining ranges are
downloaded sequentially in up to 1800-second batches: forward to EOF first,
then backward from the initial range to cover earlier audio as well.

The adapter uses `SabrStream.start({ startTimeMs })`, consumes complete library
segments until the requested end, then cancels that stream. Every batch includes
its own initialization data. Three seconds of requested overlap plus natural
segment alignment are bounded to at most 60 seconds of padding per batch; the
logical ranges stay non-overlapping. SABR segment metadata anchors container
timestamps on the absolute video clock, including nonzero starts.

Only 20-second, 16 kHz mono PCM windows enter the existing look-ahead inference
loop. Mediabunny opens at most two lazy batch readers (2 MiB read caches each),
and Web Audio resamples/downmixes only the requested windows. Windows crossing
batch boundaries are stitched on the exact 16 kHz sample grid. A seek to missing
audio preempts unrelated background work with a three-minute foreground fetch;
its generation-cancelled window cannot publish results for the old playhead.
Background download failures do not stop recognition of already cached audio;
missing ranges are retried on demand.

Each batch is capped at 64 MiB compressed and two decoded channels. Compressed
audio is stored in a private per-source OPFS directory with a 512 MiB LRU budget;
a 64 MiB in-memory LRU is used if OPFS is unavailable. Evicted ranges are fetched
again when needed. Active reads pin their files against background eviction.
Normal Stop removes only this source's UUID directory. A browser/process crash
can leave temporary files behind; there is no cross-session resume guarantee.
Live,
DRM and post-live DVR are deliberately excluded from this source.

## Checks

- `npm run test:youtube`: endpoint/header allowlist, size/cancellation checks,
  actual packaged opaque sandbox with the real YouTube.js browser fetch path,
  deterministic failure cleanup, and native stereo 8 kHz -> mono 16 kHz decoding
  of a generated WAV fixture (no downloaded audio fixture needed).
- `npm run test:youtube:online -- "https://www.youtube.com/watch?v=..."`: opt-in
  real download and CPU look-ahead smoke test, with the helper disabled. Unlike
  offline tests, it fails if the result is live fallback rather than downloaded
  audio. YouTube/network blocking can make it fail independently of code changes.
- `npm run test:audio-batches`: ten-hour coverage and duration limits, startup at
  a nonzero position, foreground seek priority, cross-batch stitching, bounded
  readers, cancellation, generated partial MP4/AAC and WebM/Opus files carrying
  two-hour timestamps, and pinned OPFS LRU/cleanup. Requires FFmpeg, not YouTube.
- `npm run test:youtube:batches:online`: actual SABR source test on `3RmK1R_BAKw`
  (2h17m), beginning at one hour, fetching a three-minute range, caching the next
  thirty-minute range, decoding across its boundary, prioritizing uncached seeks
  to the beginning/EOF, and cancelling/cleaning up.
  This source-level test intentionally isolates the downloader from YouTube's
  visual player; it is not an ASR or ten-hour end-to-end playback test. Override
  `CPU_TEST_VIDEO`, `CPU_TEST_DURATION`, and `CPU_TEST_POSITION` for another video.
- `npm run test:lookahead`: unchanged helper-backed CPU recognition/timing.
- `npm run test:capture`, `npm run test:threads`, `npm run test:local`: existing
  CPU capture, inference and matching checks.

On 2026-10-26, a fresh headless-browser test of `jEUu_bfiJHQ` downloaded the audio
through YouTube.js/SABR, decoded it, ran the CPU model and prepared the 12-second
look-ahead, with the helper disabled. Stop removed the temporary network rule.
This single successful video is not a coverage guarantee.

The long-video batch-source test also passed on 2026-10-26: initial logical range
3590–3770 seconds, subsequent background range 3770–5570 seconds, with actual
YouTube MP4 audio decoded across the boundary. Ten-hour limits/coverage are tested
deterministically; a complete ten-hour network download/playback was not run.

Offline tests do not prove that a live YouTube download succeeds. Check the
popup's preparation state/source note when testing a real video, and do not
interpret a live-listening fallback as a successful downloaded look-ahead.
