import assert from 'node:assert/strict';
import { youtubeRequest, boundedYoutubeBody, YOUTUBE_LIMITS } from '../src/cpu/youtube-policy.js';

for (const url of ['http://www.youtube.com/sw.js_data', 'https://www.youtube.com.evil.test/sw.js_data',
  'https://127.0.0.1/videoplayback', 'https://user:pass@www.youtube.com/sw.js_data',
  'https://www.youtube.com:8790/sw.js_data', 'https://www.youtube.com/youtubei/v1/playlist/edit',
  'https://www.youtube.com/o/oauth2/token', 'https://example.com/videoplayback']) {
  assert.throws(() => youtubeRequest({ url, method: 'POST' }), /denied/);
}
for (const url of ['https://www.youtube.com/sw.js_data', 'https://www.youtube.com/iframe_api',
  'https://www.youtube.com/s/player/123/player_es6.vflset/en_US/base.js',
  'https://r1---sn-example.googlevideo.com/videoplayback?sabr=1&n=keep']) {
  assert.equal(youtubeRequest({ url }).url, url);
}
const request = youtubeRequest({ url: 'https://www.youtube.com/youtubei/v1/player', method: 'POST', body: new ArrayBuffer(2),
  headers: { Cookie: 'secret', Authorization: 'secret', Origin: 'https://evil.test', 'x-goog-visitor-id': 'visitor', 'content-type': 'application/json' } });
assert.equal(request.headers.has('cookie'), false);
assert.equal(request.headers.has('authorization'), false);
assert.equal(request.headers.has('origin'), false);
assert.equal(request.headers.get('x-goog-visitor-id'), 'visitor');
assert.throws(() => youtubeRequest({ url: request.url, method: 'DELETE' }), /denied/);
assert.throws(() => youtubeRequest({ url: request.url, method: 'POST', body: new ArrayBuffer(YOUTUBE_LIMITS.requestBytes + 1) }), /large/);
assert.throws(() => youtubeRequest({ url: request.url, method: 'POST', body: 'unexpected string' }), /large/);
const signal = new AbortController().signal;
assert.deepEqual(new Uint8Array(await boundedYoutubeBody(new Response(new Uint8Array([1, 2, 3])), signal)), new Uint8Array([1, 2, 3]));
await assert.rejects(boundedYoutubeBody(new Response('oversized', { headers: { 'content-length': YOUTUBE_LIMITS.responseBytes + 1 } }), signal), /large/);
let cancelled = false;
const oversized = new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(YOUTUBE_LIMITS.responseBytes)); controller.enqueue(new Uint8Array(1)); },
  cancel() { cancelled = true; },
}));
await assert.rejects(boundedYoutubeBody(oversized, signal), /large/);
assert.equal(cancelled, true);
const abort = new AbortController(); abort.abort();
await assert.rejects(boundedYoutubeBody(new Response('stopped'), abort.signal), /abort/i);
console.log('YouTube fetch allowlist, credential filtering, size limits, cancellation and response cleanup passed.');
