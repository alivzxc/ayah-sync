// CPU browser runtime: copy the EXACT pinned ONNX Runtime version; never fetch JS/WASM
// from a CDN at inference time (MV3 CSP forbids remote executable code).
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('onnxruntime-web/wasm'));
const out = new URL('../public/ort/', import.meta.url);
await mkdir(out, { recursive: true });
for (const file of await readdir(dist)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) {
    await copyFile(join(dist, file), new URL(file, out));
    console.log(`Bundled ${file}`);
  }
}
