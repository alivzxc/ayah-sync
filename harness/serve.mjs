/**
 * Test harness server: runs the BUILT extension files in an ordinary browser
 * tab, with `chrome.*` replaced by a small shim, so the card and the popup can
 * be exercised (and screenshotted) against real audio and real timelines.
 *
 *   /                      dist/ (so the popup's /assets/... paths resolve)
 *   /harness/*             this folder
 *   /cache/*               server/cache (audio + timelines), with Range support
 *   /popup?view=ready      the built popup with the shim injected
 *   /card?tl=<name>&media=<file>   a page with a <video> and the built content script
 *
 * Run: node harness/serve.mjs   (port 5190)
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5190);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.opus': 'audio/ogg',
};

function sendFile(req, res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const safe = (base, rel) => {
    const f = normalize(join(base, rel));
    return f.startsWith(normalize(base)) ? f : null;
  };

  if (path === '/popup') {
    const html = readFileSync(join(root, 'dist/src/popup/popup.html'), 'utf8')
      .replace('<head>', '<head><script src="/harness/shim.js"></script>');
    res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(html);
  } else if (path === '/card') {
    const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'));
    const html = readFileSync(join(root, 'harness/card.html'), 'utf8')
      .replace('__CONTENT_SCRIPT__', '/' + manifest.content_scripts[0].js[0])
      .replace('__BRIDGE_SCRIPT__', '/' + manifest.content_scripts[1].js[0]);
    res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(html);
  } else if (path.startsWith('/harness/')) {
    sendFile(req, res, safe(join(root, 'harness'), path.slice(9)));
  } else if (path.startsWith('/cache/')) {
    sendFile(req, res, safe(join(root, 'server/cache'), path.slice(7)));
  } else {
    sendFile(req, res, safe(join(root, 'dist'), path));
  }
}).listen(PORT, function () { console.log(`harness on http://localhost:${this.address().port}`); });
