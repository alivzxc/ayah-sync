// Plain HTTP media only. No playlists, credentials in URLs, page extraction,
// YouTube player evaluation, blob/MSE access, or DRM handling in this source.
export const DIRECT_MEDIA_LIMITS = Object.freeze({ responseBytes: 512 * 1024, readBytes: 16 * 1024 * 1024,
  networkBytes: 128 * 1024 * 1024, audioBytes: 64 * 1024 * 1024, requests: 8192, fileBytes: 512 * 1024 ** 3 });

export function directMediaURL(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 16384) {
    throw new Error('A direct HTTP(S) media file is required');
  }
  url.hash = '';
  return url;
}

export function mediaOriginPermission(value) {
  const url = directMediaURL(value);
  // Chrome host permissions cover all ports on this hostname.
  return `${url.protocol}//${url.hostname}/*`;
}

export function mediaContentRange(value, start, end, expectedSize = null) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '');
  if (!match) throw new Error('Media server must expose valid byte-range responses');
  const [from, until, size] = match.slice(1).map(Number);
  if (![from, until, size].every(Number.isSafeInteger) || from !== start || until !== end || size <= end ||
      size > DIRECT_MEDIA_LIMITS.fileBytes || (expectedSize !== null && size !== expectedSize)) {
    throw new Error('Media range or file size changed');
  }
  return size;
}

export async function mediaRangeBody(response, expectedLength, signal) {
  if (!response.body || expectedLength > DIRECT_MEDIA_LIMITS.responseBytes ||
      (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== expectedLength)) {
    await response.body?.cancel();
    throw new Error('Invalid media byte-range response length');
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(expectedLength);
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > expectedLength) throw new Error('Media byte-range response exceeded its limit');
      bytes.set(value, size); size += value.length;
    }
    if (size !== expectedLength) throw new Error('Media byte-range response was truncated');
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
