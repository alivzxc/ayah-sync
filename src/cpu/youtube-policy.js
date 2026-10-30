// The sandbox has no extension APIs or direct network access. Its fetch bridge
// is deliberately limited to the read-only endpoints used by YouTube.js/SABR.
export const YOUTUBE_LIMITS = Object.freeze({ seconds: 10 * 60 * 60, batchSeconds: 1800, batchPadding: 60, audioBytes: 64 * 1024 * 1024,
  responseBytes: 16 * 1024 * 1024, requestBytes: 1024 * 1024, requests: 512 });

export function youtubeRequest(request) {
  const u = new URL(request.url);
  const method = (request.method || 'GET').toUpperCase();
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.href.length > 16384 ||
      !['GET', 'HEAD', 'POST'].includes(method)) throw new Error('YouTube network request denied');
  const yt = ['www.youtube.com', 'youtube.com'].includes(u.hostname);
  const allowed = yt ? (method === 'GET' || method === 'HEAD') &&
    (['/', '/sw.js_data', '/iframe_api'].includes(u.pathname) || /^\/s\/player\/[\w./-]+\.js$/.test(u.pathname)) ||
    yt && method === 'POST' && ['/youtubei/v1/player', '/youtubei/v1/config', '/api/jnn/v1/Create', '/api/jnn/v1/GenerateIT'].includes(u.pathname)
    : /(^|\.)googlevideo\.com$/.test(u.hostname) && /^\/(?:videoplayback|initplayback)(?:\/|$)/.test(u.pathname);
  if (!allowed) throw new Error('YouTube network endpoint denied');
  if (request.body != null && (!(request.body instanceof ArrayBuffer) || request.body.byteLength > YOUTUBE_LIMITS.requestBytes)) {
    throw new Error('YouTube request body is too large');
  }
  const headers = new Headers();
  const allowedHeaders = new Set(['accept', 'accept-language', 'content-type', 'range', 'x-goog-api-key',
    'x-goog-visitor-id', 'x-origin', 'x-user-agent', 'x-youtube-client-name', 'x-youtube-client-version',
    'x-goog-request-params', 'x-youtube-bootstrap-logged-in']);
  for (const [name, value] of new Headers(request.headers || [])) {
    if (allowedHeaders.has(name) && value.length <= 16384) headers.set(name, value);
  }
  return { url: u.href, method, headers, body: method === 'POST' ? request.body : undefined };
}

export async function boundedYoutubeBody(response, signal) {
  if (Number(response.headers.get('content-length')) > YOUTUBE_LIMITS.responseBytes) {
    await response.body?.cancel();
    throw new Error('YouTube response is too large');
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > YOUTUBE_LIMITS.responseBytes) throw new Error('YouTube response is too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
