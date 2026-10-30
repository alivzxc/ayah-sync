import assert from 'node:assert/strict';
import { DIRECT_MEDIA_LIMITS, directMediaURL, mediaOriginPermission, mediaContentRange, mediaRangeBody } from '../src/cpu/direct-media-policy.js';
import { createMediaRangeReader, prepareDirectMedia } from '../src/cpu/direct-media-source.js';

for (const url of ['blob:https://example.test/id', 'data:audio/wav;base64,AA==', 'file:///recording.mp3',
  'ftp://example.test/audio', 'javascript:alert(1)', 'https://user:secret@example.test/audio']) {
  assert.throws(() => directMediaURL(url), /HTTP/);
}
assert.equal(directMediaURL('https://media.example.test/audio.mp3?token=private#t=10').href, 'https://media.example.test/audio.mp3?token=private');
assert.equal(mediaOriginPermission('https://cdn.example.test:8443/audio'), 'https://cdn.example.test/*');
assert.equal(mediaContentRange('bytes 10-19/100', 10, 19), 100);
for (const value of ['bytes 0-99/100', 'bytes 10-19/*', 'bytes 10-20/100', 'bytes 10-19/19']) {
  assert.throws(() => mediaContentRange(value, 10, 19), /range|size|responses/i);
}
const reply = (start, end, { size = 100, version = '"version-1"' } = {}) => new Response(new Uint8Array(end - start + 1).fill(17), {
  status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ETag: version } });
const calls = [], signal = new AbortController().signal;
const reader = createMediaRangeReader({ url: 'https://media.example.test/audio?token=private', signal,
  async fetcher(url, options) {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    calls.push({ url, options }); return reply(Number(start), Number(end));
  } });
assert.deepEqual(await reader.probe(), { size: 100, validator: '"version-1"' });
assert.equal((await reader.read(10, 20)).length, 10);
assert.ok(calls.every((c) => c.options.method === 'GET' && c.options.redirect === 'manual' && c.options.credentials === 'omit'));
assert.ok(calls.every((c) => Object.keys(c.options.headers).join() === 'Range'), 'never add cookies, authorization, YouTube Origin or Referer overrides');
await assert.rejects(reader.read(0, DIRECT_MEDIA_LIMITS.readBytes + 1), /large/);

let cancelled = false;
const noRange = createMediaRangeReader({ url: 'https://media.example.test/audio', signal,
  async fetcher() { return new Response(new ReadableStream({ cancel() { cancelled = true; } })); } });
await assert.rejects(noRange.probe(), /ranges/);
assert.equal(cancelled, true, 'a range-ignoring server must be cancelled without downloading the whole file');
const redirect = createMediaRangeReader({ url: 'https://media.example.test/audio', signal,
  async fetcher() { return new Response(null, { status: 302, headers: { Location: 'https://other.example.test/private' } }); } });
await assert.rejects(redirect.probe(), /another origin/);
let requests = 0;
const sameOrigin = createMediaRangeReader({ url: 'https://media.example.test/audio', signal,
  async fetcher(url) { requests++; return url.endsWith('/audio')
    ? new Response(null, { status: 302, headers: { Location: '/actual.mp3' } }) : reply(0, 0); } });
await sameOrigin.probe(); assert.equal(requests, 2, 'bounded same-origin redirects are supported');
requests = 0;
const changed = createMediaRangeReader({ url: 'https://media.example.test/audio', signal,
  async fetcher() { return ++requests === 1 ? reply(0, 0) : reply(10, 19, { version: '"changed"' }); } });
await changed.probe(); await assert.rejects(changed.read(10, 20), /changed/);
const acrossBatches = createMediaRangeReader({ url: 'https://media.example.test/audio', signal,
  identity: { size: 100, validator: '"old"' }, async fetcher() { return reply(0, 0); } });
await assert.rejects(acrossBatches.probe(), /changed/);
await assert.rejects(mediaRangeBody(new Response(new Uint8Array(3)), 2, signal), /limit/);
await assert.rejects(mediaRangeBody(new Response(new Uint8Array(1)), 2, signal), /truncated/);
const abort = new AbortController(); abort.abort();
await assert.rejects(createMediaRangeReader({ url: 'https://media.example.test/audio', signal: abort.signal,
  fetcher() { throw Error('aborted reader must not fetch'); } }).probe(), { name: 'AbortError' });
await assert.rejects(prepareDirectMedia({ url: 'https://media.example.test/audio', expectedDuration: 36001, signal }), /10 hours/);
console.log('Direct-media URL/permission scope, strict range responses, bounded bodies, version pinning, redirects, abort and no-full-file fallback passed.');
