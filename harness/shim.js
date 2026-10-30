/**
 * A stand-in for the `chrome.*` extension APIs so the built popup and content
 * script run in a plain page. State comes from the URL:
 *
 *   popup:  ?view=idle|working|ready|live|helper|error
 *   card:   ?tl=<timeline json in /cache>&media=<audio in /cache>
 *   CPU UI: ?buffer=/harness/short-ayahs.json&media=<audio in /cache>
 * Buffer fixtures exercise presentation only, not ASR or extension routing.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const view = q.get('view') || 'idle';
  const listeners = [];
  const changeListeners = [];
  const local = JSON.parse(sessionStorage.getItem('qltLocal') || '{}');
  if (q.has('buffer')) local.qltRecognition = 'browser';
  window.__qlt = { listeners, local, sent: [] };

  const names = { 21: 'Al-Anbiyaa', 1: 'Al-Faatiha' };
  const sync = {
    idle: { status: 'idle' },
    helper: { status: 'idle' },
    live: { status: 'idle' },
    error: { status: 'error', tabId: 1, error: 'No Quran recitation was recognised in this video.' },
    working: { status: 'working', tabId: 1, stage: 'transcribe', pct: 0.55 },
    ready: {
      status: 'ready', tabId: 1,
      summary: {
        ayahs: 32, duration: 351, names,
        passages: [
          { from: '21:48', to: '21:65', t0: 0.6, t1: 197 },
          { from: '1:2', to: '1:7', t0: 202.5, t1: 236.9 },
          { from: '21:66', to: '21:73', t0: 241.7, t1: 323.5 },
        ],
      },
    },
  }[view];
  const state = {
    capturing: view === 'live',
    status: view === 'live' ? 'listening' : 'idle',
    lastMatch: view === 'live' ? { surah: 6, ayah: 92, surahMeta: { englishName: "Al-An'aam" } } : null,
    sync,
    error: null,
  };

  async function respond(msg) {
    window.__qlt.sent.push(msg);
    if (msg.type === 'GET_STATE') return { state };
    if (msg.type === 'PING_HELPER') {
      return view === 'helper' ? { ok: false } : { ok: true, model: 'openai/whisper-large-v3', device: 'cuda' };
    }
    if (msg.type === 'TL_HELLO') {
      if (window.__qlt.buffer) queueMicrotask(() => {
        window.__qlt.deliver({ type: 'CARD_SHOW', mode: 'lookahead', status: 'listening' });
        window.__qlt.deliver({ type: 'CARD_BUFFER', buffer: window.__qlt.buffer });
      });
      return window.__qlt.timeline ? { timeline: window.__qlt.timeline } : {};
    }
    return { ok: true };
  }

  window.chrome = {
    runtime: {
      id: 'ayah-sync-harness',
      getURL: (p) => '/' + p,
      sendMessage: (msg) => respond(msg),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    tabs: {
      query: async () => [{
        id: 1, url: 'https://www.youtube.com/watch?v=_RPZzKZsOSU',
        title: 'فجرية بديعة من سورة الأنبياء | عبدالعزيز التركي - YouTube',
      }],
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) if (k in local) out[k] = local[k];
          return cb ? cb(out) : Promise.resolve(out);
        },
        set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: local[k], newValue: v };
            local[k] = v;
          }
          sessionStorage.setItem('qltLocal', JSON.stringify(local));
          changeListeners.forEach((fn) => fn(changes, 'local'));
          return Promise.resolve();
        },
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
  };
  // Deliver a message to the page's extension listeners (what the service worker would send).
  window.__qlt.deliver = (msg) => listeners.forEach((fn) => fn(msg, {}, () => {}));
})();
