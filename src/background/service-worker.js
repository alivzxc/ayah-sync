/**
 * Service worker: orchestration hub.
 *
 * SYNC (on-demand videos): popup ──SYNC_START──▶ here ──{align,url}──▶ helper
 *   The helper downloads the audio once and returns a word-level timeline; we
 *   hand it to the tab's content script, which follows video.currentTime.
 *
 * LIVE (streams):
 *   popup ──START/STOP──▶ service worker
 *                          │  getMediaStreamId(tab)  +  ensure offscreen doc
 *                          ▼
 *                       offscreen  ──STATUS/RESULT──▶ service worker
 *                                                      │
 *                                                      ├─▶ popup (broadcast, auto)
 *                                                      └─▶ content script (card) in the captured tab
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

const state = {
  capturing: false,
  tabId: null, // the CAPTURED audio tab
  displayTabId: null, // where the card is currently shown (follows the active tab)
  status: 'idle', // idle | loading-model | listening | stopped | error
  modelProgress: null,
  lastMatch: null,
  mediaPlaying: true, // captured tab's play/pause state
  debug: null, // last human-readable working state (diagnostics)
  error: null,
  backend: 'helper',
  captureEpoch: 0,
  buffered: null,
  cpuAudioSource: null,
  cpuAudioReady: false,
  cpuAudioBatch: null,
  cpuActivity: [],
  cpuNetworkSession: null,
  // Whole-video sync: idle | working | ready | error
  sync: { status: 'idle', tabId: null, key: null, stage: null, pct: 0, summary: null, error: null },
};

const HELPER_URL = 'ws://127.0.0.1:8790';
const trCache = {}; // lang -> Promise<{ref: text}>
const HELPER_DOWN = 'The helper is not running. Open run.bat in the server folder, then try again.';

// The MV3 service worker is ephemeral — Chrome kills it when idle and re-spawns
// it on the next message, wiping in-memory `state`. Mirror state into
// chrome.storage.session so a revived SW (and a freshly opened popup) can read
// it instantly instead of waiting on the busy offscreen document.
const restored = chrome.storage.session
  .get('qltState')
  .then((r) => {
    if (r?.qltState) {
      for (const key of Object.keys(state)) {
        if (Object.hasOwn(r.qltState, key)) state[key] = r.qltState[key];
      }
    }
    // A sync that was mid-flight when the worker was recycled lost its socket.
    if (state.sync?.status === 'working') {
      state.sync = { ...state.sync, status: 'error', error: 'The sync was interrupted. Try again.' };
    }
  })
  .catch(() => {});

let broadcastTimer = null;
let lastBroadcast = 0;
function flushState() {
  chrome.storage.session.set({ qltState: state }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => {});
}

// --- Offscreen lifecycle ----------------------------------------------------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'WORKERS'],
    justification:
      'Capture the active tab audio to transcribe Quran recitation on-device.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }
}

// Recover the captured tab id after a service-worker respawn (in-memory state is
// wiped, but we persisted it to storage.session). Without this, RESULT/STATUS
// messages from the offscreen doc get dropped and the card never updates.
async function resolveTabId() {
  if (state.tabId != null) return state.tabId;
  await restored;
  return state.tabId;
}

// Where the card should be drawn — follows the active tab, falling back to the
// captured tab.
async function resolveDisplayTabId() {
  if (state.displayTabId != null) return state.displayTabId;
  await restored;
  return state.displayTabId ?? state.tabId;
}

// The built content-script filename is hashed by Vite, so read it from the
// manifest rather than hardcoding a source path (the old hardcoded path made the
// re-injection fallback silently fail, so the card never appeared on tabs that
// were open before the extension was (re)loaded).
function contentScriptFiles() {
  try {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    return cs[0]?.js || [];
  } catch {
    return [];
  }
}

// --- Content-script card control --------------------------------------------
const contentInjections = new Map();
async function reconnectContent(tabId) {
  if (contentInjections.has(tabId)) return contentInjections.get(tabId);
  const task = (async () => {
    const files = contentScriptFiles();
    if (!files.length) throw new Error('Content script is missing from the extension manifest.');
    await chrome.scripting.executeScript({ target: { tabId }, files });
    // The bundled loader imports its module asynchronously. Wait for the
    // listener, not just executeScript(), before retrying the original request.
    for (const delay of [0, 20, 50, 100, 200]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
        if (response?.ok) return;
      } catch {}
    }
    throw new Error('Could not reconnect to this video page. Refresh it and start sync again.');
  })();
  contentInjections.set(tabId, task);
  try { return await task; }
  finally { contentInjections.delete(tabId); }
}

async function askContent(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch {
    await reconnectContent(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function tellCard(tabId, message) {
  if (tabId == null) return;
  try { await askContent(tabId, message); } catch {}
}

async function captureClock() {
  const tabId = await resolveTabId();
  if (!state.capturing || tabId == null) return null;
  const epoch = state.captureEpoch;
  let timer;
  try {
    // A busy or frozen tab must not leave the caller waiting forever.
    const clock = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CLOCK' }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return clock ? { ...clock, captureEpoch: epoch } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- Whole-video sync ---------------------------------------------------------
/** Same key the content script derives, so a timeline is only reused for the
 *  video it was made for. */
function videoKey(href) {
  try {
    const u = new URL(href);
    const yt =
      (/(^|\.)youtube\.com$/.test(u.hostname) &&
        (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1])) ||
      (u.hostname === 'youtu.be' && u.pathname.slice(1, 12));
    return yt ? `yt:${yt}` : u.origin + u.pathname;
  } catch {
    return href;
  }
}

const STAGE_TEXT = {
  queued: 'Waiting for the helper…',
  download: 'Fetching the audio…',
  transcribe: 'Recognising the recitation…',
  align: 'Timing every word…',
};

/** Is the local helper running? Resolves {ok, model, device}. */
function pingHelper(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    try {
      ws = new WebSocket(HELPER_URL);
    } catch {
      return finish({ ok: false });
    }
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'ready') finish({ ok: d.capabilities?.align !== false, model: d.model, device: d.device });
      } catch {}
    };
    ws.onerror = () => finish({ ok: false });
  });
}

function summarize(timeline) {
  return {
    title: timeline.title || '',
    ayahs: timeline.ayahs.length,
    duration: timeline.duration,
    passages: (timeline.passages || []).map((p) => ({ from: p.from, to: p.to, t0: p.t0, t1: p.t1 })),
    names: Object.fromEntries(
      timeline.ayahs.map((a) => [a.surah, a.surahMeta?.englishName || `Surah ${a.surah}`]),
    ),
  };
}

const IDLE_SYNC = { status: 'idle', tabId: null, key: null, stage: null, pct: 0, summary: null, error: null };

async function startSync(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    state.sync = { ...IDLE_SYNC, status: 'error', error: 'Open a page with a video first.' };
    return flushState();
  }
  if (state.capturing) await teardown(); // one mode at a time
  const key = videoKey(tab.url);
  state.sync = { ...IDLE_SYNC, status: 'working', tabId: tab.id, key, stage: 'queued' };
  flushState();
  tellCard(tab.id, { type: 'TL_PROGRESS', text: STAGE_TEXT.queued });

  // The page's own link to the video file: the helper's fallback when it can't
  // download from the page address (Instagram / TikTok often need a login).
  let media = null;
  try {
    media = (await chrome.tabs.sendMessage(tab.id, { type: 'TL_MEDIA' }))?.src || null;
  } catch {}

  let ws;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    state.sync = { ...state.sync, status: 'error', error };
    flushState();
    tellCard(tab.id, { type: 'TL_PROGRESS', text: error, error: true });
    try {
      ws.close();
    } catch {}
  };
  try {
    ws = new WebSocket(HELPER_URL);
  } catch {
    return fail(HELPER_DOWN);
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'align', url: tab.url, force, media }));
  ws.onerror = () => fail(HELPER_DOWN);
  ws.onclose = () => fail('Lost the connection to the helper.');
  ws.onmessage = async (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.type === 'align_progress') {
      if (state.sync.stage !== d.stage) {
        tellCard(tab.id, { type: 'TL_PROGRESS', text: STAGE_TEXT[d.stage] || 'Working…' });
      }
      state.sync.stage = d.stage;
      state.sync.pct = d.pct;
      broadcastState();
    } else if (d.type === 'align_error') {
      fail(d.error || 'Could not sync this video.');
    } else if (d.type === 'align_result') {
      settled = true;
      const timeline = d.timeline;
      await chrome.storage.session.set({ [`qltTL_${tab.id}`]: { key, timeline } }).catch(() => {});
      state.sync = { ...IDLE_SYNC, status: 'ready', tabId: tab.id, key, pct: 1, summary: summarize(timeline) };
      flushState();
      tellCard(tab.id, { type: 'TL_LOAD', timeline });
      try {
        ws.close();
      } catch {}
    }
  };
}

async function clearSync(tabId) {
  const id = tabId ?? state.sync.tabId;
  if (id != null) {
    await chrome.storage.session.remove(`qltTL_${id}`).catch(() => {});
    tellCard(id, { type: 'TL_CLEAR' });
  }
  state.sync = { ...IDLE_SYNC };
  flushState();
}

// --- Start / stop -----------------------------------------------------------

/**
 * Tear down any existing capture. Critical: the offscreen document holds the
 * tab's MediaStream, and MV3 service workers are ephemeral — so after a SW
 * restart an *orphaned* capture can still be running while our in-memory state
 * says idle. Closing the offscreen document releases the stream, which is what
 * clears Chrome's "Cannot capture a tab with an active stream" error.
 */
async function teardown() {
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' });
    } catch {}
    await closeOffscreen();
  }
  await setCpuYoutubeNetwork(false).catch(() => {});
  state.cpuNetworkSession = null;
  for (const t of new Set([state.tabId, state.displayTabId])) {
    if (t != null) {
      try {
        await tellCard(t, { type: 'CARD_HIDE' });
      } catch {}
    }
  }
  state.capturing = false;
  state.captureEpoch++;
  state.tabId = null;
  state.displayTabId = null;
  state.status = 'idle';
  state.modelProgress = null;
  state.preparationText = null;
  state.buffered = null;
  state.cpuAudioSource = null;
  state.cpuAudioReady = false;
  state.cpuAudioBatch = null;
  state.cpuActivity = [];
}

async function cpuLookaheadAvailable() {
  try {
    const response = await fetch('http://127.0.0.1:8790/health', { signal: AbortSignal.timeout(350), cache: 'no-store' });
    return response.ok && (await response.json()).cpu_audio === true;
  } catch { return false; }
}

async function setCpuYoutubeNetwork(enabled) {
  const id = 8791;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: enabled ? [{
    id, priority: 1,
    condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['youtube.com', 'googlevideo.com'],
      resourceTypes: ['xmlhttprequest'] },
    action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'origin', operation: 'set', value: 'https://www.youtube.com' },
      { header: 'referer', operation: 'set', value: 'https://www.youtube.com/' },
    ] },
  }] : [] });
}

async function startCpuLookahead(tab, page, { youtubeId = null, directMedia = false, mediaCredentials = 'omit',
  helperAvailable = true, attempt = state.captureEpoch } = {}) {
  const url = tab.url || page.href;
  const { qltCPUHighlight = true } = await chrome.storage.local.get('qltCPUHighlight');
  // Keep a live fallback usable after the popup closes. The offscreen document
  // consumes this optional token now and keeps the captured tab audible.
  let streamId = null;
  if (youtubeId || directMedia) {
    try { streamId = (await chrome.runtime.sendMessage({ type: 'CAPTURE_TOKEN', tabId: tab.id }))?.streamId || null; } catch {}
  }
  if (attempt !== state.captureEpoch) return;
  await ensureOffscreen();
  if (attempt !== state.captureEpoch) { if (!state.capturing) await closeOffscreen(); return; }
  Object.assign(state, { capturing: true, tabId: tab.id, displayTabId: tab.id, backend: 'lookahead',
    status: 'loading-model', error: null, lastMatch: null, buffered: null,
    cpuAudioSource: youtubeId ? 'youtubejs' : directMedia ? 'direct' : 'helper',
    debug: youtubeId ? 'CPU look-ahead · starting YouTube.js browser download…'
      : directMedia ? 'CPU look-ahead · fetching standard media audio in browser…' : 'CPU look-ahead · fetching video audio in background…' });
  recordCpuActivity(state.debug);
  state.captureEpoch++;
  await tellCard(tab.id, { type: 'CARD_SHOW', status: state.status, mode: 'lookahead' });
  await tellCard(tab.id, { type: 'CARD_WATCH_MEDIA' });
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'START_LOOKAHEAD', url,
    media: page.src, startTime: page.time, key: videoKey(url), captureEpoch: state.captureEpoch, highlightEnabled: qltCPUHighlight,
    youtubeId, directMedia, mediaCredentials, helperAvailable, expectedDuration: page.duration, streamId });
  broadcastState(); updateBadge();
}

async function startCapture(targetTabId = null) {
  // Always start from a clean slate — releases any orphaned stream on this or a
  // previous tab so getMediaStreamId can't fail with "active stream".
  await teardown();
  const attempt = state.captureEpoch;
  if (state.sync.status !== 'idle') await clearSync(); // one mode at a time

  const tab = targetTabId == null ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    : await chrome.tabs.get(targetTabId);
  if (!tab?.id) {
    setError('No active tab to capture.');
    return;
  }

  const { qltRecognition = 'helper', qltCPULookahead = true } = await chrome.storage.local.get(['qltRecognition', 'qltCPULookahead']);
  if (qltRecognition === 'browser' && qltCPULookahead) {
    let page;
    try { page = await askContent(tab.id, { type: 'TL_MEDIA' }); } catch (error) {
      setError(error.message || 'Refresh the video page and start CPU sync again.');
      return;
    }
    if (page && Number.isFinite(page.duration) && page.duration > 0 && /^https?:/.test(tab.url || page.href || '')) {
      const helperAvailable = await cpuLookaheadAvailable();
      if (attempt !== state.captureEpoch) return;
      const youtubeId = page.duration <= 10 * 60 * 60 ? videoKey(tab.url || page.href).match(/^yt:([\w-]{11})$/)?.[1] : null;
      let directMedia = false, mediaCredentials = 'omit';
      try {
        const media = new URL(page.src);
        directMedia = !videoKey(tab.url || page.href).startsWith('yt:') && !page.encrypted && page.duration <= 36000 &&
          ['http:', 'https:'].includes(media.protocol) && !media.username && !media.password && media.href.length <= 16384;
        if (directMedia && await chrome.permissions?.contains({ origins: [`${media.protocol}//${media.hostname}/*`] })) mediaCredentials = 'include';
      } catch {}
      if (youtubeId || directMedia || helperAvailable) return startCpuLookahead(tab, page,
        { youtubeId, directMedia, mediaCredentials, helperAvailable, attempt });
    }
  }

  let streamId;
  try {
    // Isolated extension documents and the MV3 service worker do not share a
    // renderer. A SW-issued token fails with "Error starting tab capture"
    // under COOP/COEP. The popup issues a token usable by the offscreen page.
    const token = await chrome.runtime.sendMessage({ type: 'CAPTURE_TOKEN', tabId: tab.id });
    if (!token?.streamId) throw new Error(token?.error || 'Keep the extension popup open while capture starts.');
    streamId = token.streamId;
  } catch (err) {
    setError(
      `Could not start tab capture: ${err?.message || err}. ` +
        'Try reloading the tab, then Start again.',
    );
    return;
  }

  await ensureOffscreen();

  state.capturing = true;
  state.tabId = tab.id;
  state.displayTabId = tab.id;
  state.status = 'loading-model';
  state.error = null;
  state.lastMatch = null;
  state.debug = null;

  state.backend = qltRecognition;
  state.captureEpoch++;

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    backend: qltRecognition,
    captureEpoch: state.captureEpoch,
  });

  await tellCard(tab.id, { type: 'CARD_SHOW', status: state.status });
  await tellCard(tab.id, { type: 'CARD_WATCH_MEDIA' }); // watch this tab's play/pause
  broadcastState();
  updateBadge();
}

async function stopCapture() {
  await teardown();
  broadcastState();
  updateBadge();
}

function setError(msg) {
  recordCpuActivity('CPU sync stopped due to an error.');
  state.error = msg;
  state.status = 'error';
  state.capturing = false;
  broadcastState();
  updateBadge();
}

// --- UI feedback ------------------------------------------------------------
function recordCpuActivity(text) {
  if (!state.capturing || !['browser', 'lookahead'].includes(state.backend) || typeof text !== 'string' || !text.trim()) return;
  text = text.replace(/(?:https?|wss?):\/\/\S+/g, '[URL]').trim().slice(0, 220);
  // Update a phase's progress in place instead of filling the log with every
  // percentage/elapsed-time update. Keep history across popup close/reopen.
  const key = text.replace(/\d+(?:\.\d+)?/g, '#');
  const last = state.cpuActivity.at(-1);
  if (last?.key === key) last.text = text;
  else state.cpuActivity = [...state.cpuActivity, { text, key, at: Date.now() }].slice(-8);
}

function updateBadge() {
  const on = state.capturing;
  chrome.action.setBadgeText({ text: on ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#1f9d55' : '#000000' });
}

function broadcastState(immediate = false) {
  // Throttle to ~2.5×/s and coalesce bursts (the offscreen emits many DEBUG/
  // RESULT messages), so we don't flood messaging or thrash storage.
  const now = Date.now();
  if (immediate) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    lastBroadcast = now;
    flushState();
    return;
  }
  const gap = now - lastBroadcast;
  if (gap >= 400) {
    lastBroadcast = now;
    flushState();
  } else if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      lastBroadcast = Date.now();
      flushState();
    }, 400 - gap);
  }
}

// --- Message routing --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages we send to the offscreen doc.
  if (msg?.target === 'offscreen') return;

  switch (msg?.type) {
    case 'CPU_YT_NETWORK':
      (async () => {
        await restored;
        if (sender.url !== chrome.runtime.getURL(OFFSCREEN_URL) ||
            (msg.enabled && (!state.capturing || state.backend !== 'lookahead'))) return sendResponse({ ok: false });
        if (msg.enabled === true) {
          if (!/^[\da-f-]{36}$/.test(msg.sessionId || '')) return sendResponse({ ok: false });
          state.cpuNetworkSession = msg.sessionId;
          await setCpuYoutubeNetwork(true);
        } else if (msg.sessionId === state.cpuNetworkSession) {
          state.cpuNetworkSession = null;
          await setCpuYoutubeNetwork(false);
        }
        // Persist ownership across service-worker suspension. An older source's
        // cleanup must not remove a newer CPU download's network rule.
        chrome.storage.session.set({ qltState: state }).catch(() => {});
        sendResponse({ ok: true });
      })().catch(() => sendResponse({ ok: false }));
      return true;
    case 'CPU_AUDIO_SOURCE':
      if (sender.url === chrome.runtime.getURL(OFFSCREEN_URL) && state.capturing && state.backend === 'lookahead') {
        state.cpuAudioSource = ['youtubejs', 'direct'].includes(msg.source) ? msg.source : 'helper';
        state.cpuAudioReady = true;
        recordCpuActivity(msg.source === 'youtubejs' ? 'First audio batch ready · YouTube.js'
          : msg.source === 'direct' ? 'First audio batch ready · standard media' : 'Audio ready · local helper');
        broadcastState();
      }
      return;
    case 'CPU_AUDIO_BATCH': {
      const p = msg.progress;
      if (sender.url !== chrome.runtime.getURL(OFFSCREEN_URL) || !state.capturing || state.backend !== 'lookahead' ||
          !p || !['background', 'seek'].includes(p.phase) || !Number.isFinite(p.start) || !Number.isFinite(p.end) ||
          p.start < 0 || p.end <= p.start || p.end > 36000 || p.end - p.start > 1800 ||
          !['session', 'attestation', 'download', 'decode', 'ready', 'failed'].includes(p.stage)) return;
      const range = `${Math.floor(p.start / 60)}–${Math.ceil(p.end / 60)} min`;
      const pct = p.stage === 'download' && p.total > 0 && Number.isFinite(p.received / p.total)
        ? ` · ${Math.min(100, Math.round(p.received / p.total * 100))}%` : '';
      const prefix = p.phase === 'seek' ? 'Preparing audio at seek' : 'Background audio';
      const text = `${prefix} · ${range}${pct}${p.stage === 'ready' ? ' · cached' : p.stage === 'failed' ? ' · will retry when needed' : ''}`;
      state.cpuAudioBatch = { ...p, text, lastReady: p.stage === 'ready'
        ? { start: p.start, end: p.end } : state.cpuAudioBatch?.lastReady || null };
      recordCpuActivity(text);
      broadcastState();
      return;
    }
    case 'CPU_LIVE_FALLBACK':
      (async () => {
        await restored;
        if (sender.url !== chrome.runtime.getURL(OFFSCREEN_URL) || !state.capturing || state.backend !== 'lookahead') {
          return sendResponse({ cancelled: true });
        }
        const tabId = state.tabId, epoch = state.captureEpoch;
        let streamId = null;
        if (!msg.hasStream) {
          try { streamId = (await chrome.runtime.sendMessage({ type: 'CAPTURE_TOKEN', tabId }))?.streamId; } catch {}
          if (!streamId) return sendResponse({ error: 'Browser downloading was unavailable. Reopen the popup, disable Auto CPU look-ahead, then start live listening.' });
        }
        if (!state.capturing || state.tabId !== tabId || state.captureEpoch !== epoch) return sendResponse({ cancelled: true });
        Object.assign(state, { backend: 'browser', cpuAudioSource: 'live', buffered: null, lastMatch: null,
          cpuAudioReady: false, cpuAudioBatch: null, status: 'loading-model', preparationText: null, debug: 'Browser download unavailable · listening live instead' });
        recordCpuActivity(state.debug);
        await tellCard(tabId, { type: 'CARD_HIDE' });
        await tellCard(tabId, { type: 'CARD_SHOW', status: state.status });
        broadcastState();
        sendResponse({ ok: true, streamId });
      })().catch(() => sendResponse({ error: 'Could not switch to CPU live listening.' }));
      return true;
    case 'CAPTURE_CLOCK':
      captureClock().then(sendResponse);
      return true;
    case 'CAPTURE_RESET':
      (async () => {
        const capId = await resolveTabId();
        if (state.capturing && sender?.tab?.id === capId) {
          state.lastMatch = null;
          state.buffered = null;
          state.captureEpoch++;
          state.debug = 'Seeking — confirming the new passage…';
          broadcastState();
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESET_CAPTURE', captureEpoch: state.captureEpoch,
            time: Number.isFinite(msg.time) ? msg.time : null }).catch(() => {});
        }
      })();
      return true;
    case 'TR_GET':
      // Translations in other languages ship inside the extension (public/tr).
      (async () => {
        try {
          trCache[msg.lang] ||= fetch(chrome.runtime.getURL(`tr/${msg.lang}.json`)).then((r) => r.json());
          const all = await trCache[msg.lang];
          sendResponse({ map: Object.fromEntries((msg.refs || []).map((r) => [r, all[r]]).filter((e) => e[1])) });
        } catch {
          delete trCache[msg.lang];
          sendResponse({});
        }
      })();
      return true;

    case 'MEDIA_TOGGLE':
      (async () => {
        const capId = await resolveTabId();
        if (capId != null) tellCard(capId, { type: 'CARD_TOGGLE_MEDIA' });
      })();
      return true;

    case 'FONT_GET':
      (async () => {
        try {
          if (!['uthmani.woff2', 'indopak.woff2', 'figtree.woff2'].includes(msg.file)) return sendResponse({});
          const response = await fetch(chrome.runtime.getURL(`fonts/${msg.file}`));
          if (!response.ok) throw new Error('Bundled font missing');
          const buf = await response.arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          sendResponse({ b64: btoa(bin) });
        } catch {
          sendResponse({});
        }
      })();
      return true;

    case 'PING_HELPER':
      (async () => {
        // Also enforce this here: a stale popup or another extension context
        // must not open a loopback socket while browser-only mode is selected.
        const { qltRecognition = 'helper' } = await chrome.storage.local.get('qltRecognition');
        sendResponse(qltRecognition === 'browser' ? { ok: false, disabled: true } : await pingHelper());
      })();
      return true;

    case 'SYNC_START':
      startSync(!!msg.force);
      sendResponse?.({ ok: true });
      return true;

    case 'SYNC_CLEAR':
      clearSync(sender?.tab?.id);
      sendResponse?.({ ok: true });
      return true;

    case 'TL_HELLO':
      // A page (re)loaded: give it back the timeline made for this tab + video.
      (async () => {
        const id = sender?.tab?.id;
        const k = `qltTL_${id}`;
        const r = id != null ? await chrome.storage.session.get(k).catch(() => ({})) : {};
        const saved = r[k];
        if (saved && saved.key === videoKey(msg.url || '')) {
          sendResponse({ timeline: saved.timeline });
        } else {
          sendResponse({});
        }
      })();
      return true;

    case 'MEDIA_STATE':
      // Play/pause report from a content script — only act on the captured tab,
      // and forward it to wherever the card currently is.
      (async () => {
        const capId = await resolveTabId();
        if (sender?.tab?.id != null && sender.tab.id === capId) {
          state.mediaPlaying = msg.playing !== false;
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'MEDIA_PLAYING', playing: state.mediaPlaying }).catch(() => {});
          const disp = await resolveDisplayTabId();
          if (disp != null) tellCard(disp, { type: 'CARD_MEDIA', playing: state.mediaPlaying });
          broadcastState();
        }
      })();
      return true;
    case 'BUFFER_POSITION':
      if (sender?.tab?.id === state.tabId && state.backend === 'lookahead' && state.capturing &&
          msg.captureEpoch === state.captureEpoch && msg.match) {
        const changed = state.lastMatch?.ref !== msg.match.ref;
        state.lastMatch = msg.match;
        broadcastState(changed);
      }
      return true;
    case 'GET_STATE':
      // Reconcile with reality: the offscreen document existing is the source of
      // truth for "are we capturing", so the popup self-corrects after a SW
      // restart (shows Stop for an orphaned capture instead of Start).
      (async () => {
        await restored; // ensure persisted state is loaded after a SW respawn
        const live = await hasOffscreen();
        if (!live && state.capturing) {
          state.capturing = false;
          state.status = 'idle';
        } else if (live) {
          state.capturing = true;
        }
        sendResponse({ state });
      })();
      return true;

    case 'START':
      startCapture().catch((error) => {
        setError(error.message || String(error));
        closeOffscreen();
      });
      sendResponse?.({ ok: true });
      return true;

    case 'CPU_RESTART_VIDEO':
      (async () => {
        const { qltRecognition } = await chrome.storage.local.get('qltRecognition');
        if (qltRecognition !== 'browser' || sender?.tab?.id == null) {
          sendResponse({ error: 'This button is only available for Browser CPU.' });
          return;
        }
        try {
          await startCapture(sender.tab.id);
          if (state.error) {
            await tellCard(sender.tab.id, { type: 'CARD_SHOW', status: 'error' });
            await tellCard(sender.tab.id, { type: 'CARD_STATUS', status: 'error', error: state.error });
          }
          sendResponse(state.error ? { error: state.error } : { ok: true });
        } catch (error) {
          await tellCard(sender.tab.id, { type: 'CARD_SHOW', status: 'error' });
          sendResponse({ error: error.message || String(error) });
        }
      })();
      return true;

    case 'STOP':
      stopCapture();
      sendResponse?.({ ok: true });
      return true;

    // --- messages coming FROM the offscreen document ---
    case 'STATUS':
      state.status = msg.status;
      state.preparationText = msg.detail || null;
      recordCpuActivity(msg.detail || (msg.status === 'loading-model' ? 'Loading CPU model…'
        : msg.status === 'listening' ? state.backend === 'lookahead' ? 'Preparing the look-ahead buffer…' : 'Live CPU recognition ready' : ''));
      if (msg.status === 'stopped') state.capturing = false;
      broadcastState();
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null) tellCard(tabId, { type: 'CARD_STATUS', status: msg.status, detail: msg.detail });
      })();
      return true;

    case 'MODEL_PROGRESS':
      state.modelProgress = msg.progress;
      broadcastState();
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null)
          tellCard(tabId, { type: 'CARD_STATUS', status: 'loading-model', progress: msg.progress, detail: state.preparationText });
      })();
      return true;

    case 'RESULT':
      (async () => {
        const tabId = await resolveDisplayTabId();
        let ayahChanged = false;
        if (msg.match) {
          if (msg.captureEpoch != null && (!state.capturing || msg.captureEpoch !== state.captureEpoch)) return;
          if (msg.clock && msg.clock.captureEpoch !== state.captureEpoch) return;
          if (msg.clock && (!state.capturing || msg.clock.captureEpoch !== state.captureEpoch)) return;
          ayahChanged = state.lastMatch?.ref !== msg.match.ref;
          state.lastMatch = state.backend === 'browser' ? { ...msg.match, highlight: msg.highlight || null } : msg.match;
          if (tabId != null) tellCard(tabId, { type: 'CARD_UPDATE', match: state.lastMatch });
        } else if (tabId != null) {
          tellCard(tabId, { type: 'CARD_STATUS', status: 'listening' });
        }
        broadcastState(state.backend === 'browser' && ayahChanged);
      })();
      return true;

    case 'HIGHLIGHT':
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (!state.capturing || state.backend !== 'browser' || !state.lastMatch) return;
        if (msg.captureEpoch != null && msg.captureEpoch !== state.captureEpoch) return;
        if (msg.clock && msg.clock.captureEpoch !== state.captureEpoch) return;
        if (msg.highlight && msg.highlight.ref !== state.lastMatch.ref) return;
        state.lastMatch = { ...state.lastMatch, highlight: msg.highlight || null };
        if (tabId != null) tellCard(tabId, { type: 'CARD_HIGHLIGHT', highlight: msg.highlight || null });
        broadcastState();
      })();
      return true;

    case 'DEBUG':
      state.debug = msg.text;
      if (/(?:YouTube\.js|Direct media).*(?:blocked|unavailable)|trying the local audio helper/i.test(msg.text || '')) recordCpuActivity(msg.text);
      broadcastState();
      if (state.capturing && ['browser', 'lookahead'].includes(state.backend)) {
        (async () => {
          const tabId = await resolveDisplayTabId();
          if (tabId != null) tellCard(tabId, { type: 'CARD_DEBUG', text: msg.text });
        })();
      }
      return true;

    case 'BUFFER':
      (async () => {
        const tabId = await resolveTabId();
        if (!state.capturing || state.backend !== 'lookahead' || msg.captureEpoch !== state.captureEpoch) return;
        if (msg.ready && !state.buffered?.ready) recordCpuActivity('Look-ahead buffer ready · following video playback');
        state.buffered = msg;
        if (tabId != null) tellCard(tabId, { type: 'CARD_BUFFER', buffer: msg });
        broadcastState();
      })();
      return true;

    case 'ERROR':
      setError(msg.error);
      (async () => {
        const tabId = await resolveDisplayTabId();
        if (tabId != null)
          tellCard(tabId, { type: 'CARD_STATUS', status: 'error', error: msg.error });
        await closeOffscreen(); // Do not report a stopped recognizer as an orphaned active capture.
      })();
      return true;
  }
});

// --- Card follows the active tab -------------------------------------------
async function moveCardTo(tabId) {
  if (state.backend === 'lookahead') return; // Timed display follows its source video's clock.
  if (!state.capturing || tabId == null || tabId === state.displayTabId) return;
  const prev = state.displayTabId;
  state.displayTabId = tabId;
  // Draw the card on the newly-active tab with the latest known verse/status.
  await tellCard(tabId, { type: 'CARD_SHOW', status: state.status });
  if (state.lastMatch) await tellCard(tabId, { type: 'CARD_UPDATE', match: state.lastMatch });
  else await tellCard(tabId, { type: 'CARD_STATUS', status: state.status });
  await tellCard(tabId, { type: 'CARD_MEDIA', playing: state.mediaPlaying }); // keep pause state
  if (prev != null && prev !== tabId) await tellCard(prev, { type: 'CARD_HIDE' });
  flushState();
}

chrome.tabs.onActivated.addListener(async (info) => {
  await restored;
  moveCardTo(info.tabId);
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  await restored;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
    if (tab?.id != null) moveCardTo(tab.id);
  } catch {}
});
// If the captured tab closes, stop cleanly.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.capturing && tabId === state.tabId) stopCapture();
  chrome.storage.session.remove(`qltTL_${tabId}`).catch(() => {});
  if (state.sync.tabId === tabId) {
    state.sync = { ...IDLE_SYNC };
    flushState();
  }
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

// Offscreen documents only expose chrome.runtime, not chrome.storage. Forward
// this CPU-only preference through the existing background/offscreen channel.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.qltCPUHighlight) return;
  await restored;
  if (state.capturing && state.backend === 'lookahead') {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'CPU_HIGHLIGHT_SETTING',
      enabled: changes.qltCPUHighlight.newValue !== false }).catch(() => {});
  }
});
