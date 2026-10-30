import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Ayah Sync',
  version: pkg.version,
  description:
    'Follows Quran recitation videos with translations using browser CPU recognition or the local GPU helper.',
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Ayah Sync',
  },
  background: {
    service_worker: 'src/background/service-worker.js',
    type: 'module',
  },
  permissions: ['tabCapture', 'activeTab', 'offscreen', 'storage', 'scripting', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['http://127.0.0.1:8790/*', 'https://www.youtube.com/*', 'https://youtube.com/*', 'https://*.googlevideo.com/*'],
  // Requested per media hostname from the Start button, not granted globally.
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  // Shared-memory WASM threads require both policies. Capture tokens must be
  // issued by the popup (not the service worker); see CAPTURE_TOKEN routing.
  cross_origin_opener_policy: { value: 'same-origin' },
  cross_origin_embedder_policy: { value: 'require-corp' },
  // Player/challenge evaluation is confined to an opaque-origin sandbox. The
  // recognizer and privileged extension pages keep their existing script policy.
  sandbox: { pages: ['src/cpu/youtube-sandbox.html'] },
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'; connect-src 'self' https: http: ws://127.0.0.1:8790 ws://localhost:8790; frame-src 'self'",
    sandbox: "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; child-src 'none'; object-src 'none'",
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.js'],
      run_at: 'document_idle',
    },
    {
      // Opens the "keep on top" window; that API only exists in the page's world.
      matches: ['<all_urls>'],
      js: ['src/content/pip-bridge.js'],
      run_at: 'document_idle',
      world: 'MAIN',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['assets/*', 'worklet/*', 'fonts/*'],
      matches: ['<all_urls>'],
    },
  ],
});
