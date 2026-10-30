import { displayWordIndices } from '../cpu/display-word.js';
import { displayTiming } from '../cpu/display-timing.js';
import { CPU_LOOKAHEAD_SECONDS } from '../cpu/startup-buffer.js';
const DEV_MODE = import.meta.env.DEV;

/**
 * Content script: the verse card.
 *
 * Two ways of knowing where the recitation is:
 *
 *   SYNCED  — the helper aligned the whole video once and gave us a word-level
 *             timeline. We read the page's video.currentTime every frame and
 *             look the word up. Exact; pausing, seeking and replaying just work.
 *
 *   LIVE    — for live streams. The helper reports the current ayah every few
 *             seconds and we estimate the word in between.
 *
 * The card lives in a Shadow DOM so page CSS can't touch it.
 */

const HOST_ID = '__qlt_card_host__';
const LEAD_S = 0.1; // light a word a touch before its first sound, as the eye expects

let host, shadow, els;
let dragState = null;
let showTranslation = true;
let script = 'uthmani'; // 'uthmani' | 'indopak'
let fontSize = 24; // Arabic text size (px)
let cardWidth = 360;
let lang = 'en'; // translation language
let trMap = {}; // ref -> translation text, for the non-English languages
let ambient = true; // tint the card with the video's (or page's) colours

// What is on the card right now.
let shown = null; // ayah object currently rendered
let builtText = '';
let wordEls = [];

// --- Synced mode --------------------------------------------------------------
let tl = null; // { ayahs:[{ref,t0,t1,w:[...],arabic,...}], duration, key, ... }
let tlRaf = null;
let tlIdx = -2;
let lastHref = location.href;
let inPip = false; // the card is in the always-on-top window
// The tab's own animation frames stop when it is in the background, which is
// exactly when the floating window is used — so drive updates with a timer
// there (tabs playing audio are not throttled).
const raf = (fn) => (inPip ? -setTimeout(fn, 50) : requestAnimationFrame(fn));
const caf = (id) => {
  if (id == null) return;
  if (id < 0) clearTimeout(-id);
  else cancelAnimationFrame(id);
};

// --- Live mode ----------------------------------------------------------------
let liveMatch = null;
let anchorWord = 0;
let anchorTime = 0;
let shownWord = -1; // never decreases within an ayah
let rate = 1.0;
let prevWord = 0;
let prevTime = 0;
let liveRaf = null;
let mediaPlaying = true;
let browserCPU = false;
let cpuHighlight = true;
let cpuLookaheadPreference = true;
let cpuHighlightPreference;
let highlightTimer = null;
let cpuBuffer = null;
const cpuSegments = new Map();
let bufferRaf = null;
let bufferedWord = -2;
let bufferedRef = null;
let cpuBufferedMode = false;
const MAX_DRIFT_MS = 7000;
const MAX_LEAD = 4;
const contentLifecycle = new AbortController();
let disposed = false;
let mediaTimer = null;

function disposeContent() {
  if (disposed) return;
  disposed = true;
  contentLifecycle.abort();
  clearInterval(mediaTimer);
  mediaTimer = null;
  clearTimeline();
  hideCard();
  try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
}

function extensionAvailable() {
  if (disposed) return false;
  try { if (chrome.runtime?.id) return true; } catch {}
  disposeContent();
  return false;
}

function runtimeMessage(message) {
  if (!extensionAvailable()) return Promise.resolve(null);
  const invalidated = (error) => {
    if (/extension context invalidated/i.test(error?.message || '')) {
      disposeContent();
      return null;
    }
    throw error;
  };
  // sendMessage can throw synchronously after an extension reload, before an
  // ordinary .catch() can run. Old page scripts must stop, not keep painting.
  try { return chrome.runtime.sendMessage(message).catch(invalidated); }
  catch (error) {
    try { return Promise.resolve(invalidated(error)); }
    catch (other) { return Promise.reject(other); }
  }
}

// =============================================================== preferences
chrome.storage?.local.get(['showTranslation', 'qltScript', 'qltFontSize', 'qltCardWidth', 'qltAmbient', 'qltLang', 'qltRecognition', 'qltCPUHighlight', 'qltCPULookahead'], (v) => {
  if (disposed) return;
  browserCPU = v?.qltRecognition === 'browser';
  cpuLookaheadPreference = v?.qltCPULookahead !== false;
  cpuHighlightPreference = v?.qltCPUHighlight;
  cpuHighlight = cpuHighlightPreference ?? cpuLookaheadPreference;
  if (v?.qltLang) lang = v.qltLang;
  ambient = v?.qltAmbient !== false;
  showTranslation = v?.showTranslation !== false;
  if (v?.qltScript) script = v.qltScript;
  if (v?.qltFontSize) fontSize = v.qltFontSize;
  if (v?.qltCardWidth) cardWidth = v.qltCardWidth;
  applyPrefs();
  rerender();
});
chrome.storage?.onChanged.addListener((changes, area) => {
  if (disposed) return;
  if (area !== 'local') return;
  if (changes.qltRecognition || changes.qltCPUHighlight || changes.qltCPULookahead) {
    if (changes.qltRecognition) browserCPU = changes.qltRecognition.newValue === 'browser';
    if (changes.qltCPUHighlight) cpuHighlightPreference = changes.qltCPUHighlight.newValue;
    if (changes.qltCPULookahead) cpuLookaheadPreference = changes.qltCPULookahead.newValue !== false;
    cpuHighlight = cpuHighlightPreference ?? cpuLookaheadPreference;
    if (cpuBuffer) bufferedWord = -2;
    else if (liveMatch) showLive(liveMatch);
    else if (browserCPU && !tl) paintWords(Infinity);
  }
  if (changes.showTranslation) showTranslation = changes.showTranslation.newValue !== false;
  if (changes.qltScript) script = changes.qltScript.newValue || 'uthmani';
  if (changes.qltFontSize) fontSize = changes.qltFontSize.newValue || 24;
  if (changes.qltCardWidth) cardWidth = changes.qltCardWidth.newValue || 360;
  if (changes.qltLang) {
    lang = changes.qltLang.newValue || 'en';
    trMap = {};
    rerender();
    loadTranslations(tl ? tl.ayahs.map((a) => a.ref) : shown ? [shown.ref, shown.__next?.ref] : []);
  }
  if (changes.qltAmbient) {
    ambient = changes.qltAmbient.newValue !== false;
    paintAmbient(true);
  }
  applyPrefs();
  if (changes.showTranslation || changes.qltScript) rerender();
});

function applyPrefs() {
  if (!host) return;
  host.style.setProperty('--ar-size', `${fontSize}px`);
  host.style.setProperty('--card-w', `${cardWidth}px`);
  host.style.setProperty(
    '--ar-font',
    script === 'indopak'
      ? "'QLT-IndoPak','Noto Naskh Arabic',serif"
      : "'QLT-Uthmani','Amiri Quran','Amiri',serif",
  );
}

function rerender() {
  if (!els || !shown) return;
  const a = shown;
  shown = null;
  builtText = '';
  renderAyah(a, a.__next || null);
  if (cpuBuffer) bufferedWord = -2;
  else if (!tl && browserCPU && liveMatch) paintCpuHighlight(liveMatch.highlight);
}

// ===================================================================== fonts
// Chrome ignores @font-face rules written inside a shadow root, so the card's
// fonts are registered on the document itself with the FontFace API. The bytes
// are fetched once and reused for the floating window's document.
const FONT_FILES = [
  ['QLT-Uthmani', 'uthmani.woff2', {}],
  ['QLT-IndoPak', 'indopak.woff2', {}],
  ['QLT-Text', 'figtree.woff2', { weight: '400 700' }],
];
let fontBytes = null; // Promise<[name, ArrayBuffer, descriptors][]>

function fetchFonts() {
  if (fontBytes) return fontBytes;
  fontBytes = Promise.all(
    FONT_FILES.map(async ([name, file, desc]) => {
      // Fetch in the extension, not the host page's security context. Direct
      // extension URLs can be rejected by sites such as YouTube even when the
      // files are web-accessible; falling back afterwards still logs errors.
      const r = await runtimeMessage({ type: 'FONT_GET', file });
      if (!r?.b64) throw new Error(`Bundled font unavailable: ${file}`);
      const bin = atob(r.b64);
      const buf = Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      return [name, buf, desc];
    }),
  );
  fontBytes.then((list) => window.postMessage({ qltFonts: list.map(([n, b, d]) => [n, b.slice(0), d]) }, location.origin)).catch(() => {});
  return fontBytes;
}

async function installFonts(win) {
  try {
    for (const [name, buf, desc] of await fetchFonts()) {
      if (!buf.byteLength) continue;
      const face = new win.FontFace(name, buf.slice(0), desc);
      await face.load();
      win.document.fonts.add(face);
    }
  } catch (e) {
    console.warn('[qlt] fonts not installed', e);
  }
}

// ====================================================================== card
function ensureCard() {
  if (host && host.isConnected) return;

  // A previous extension build can leave an orphaned card in an existing tab.
  // Only the newly connected content script may own this page's card.
  document.querySelectorAll(`#${HOST_ID}`).forEach((node) => node.remove());

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; top:76px; right:24px;';
  shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        --ar-size: 24px; --card-w: 360px;
        --ar-font: 'QLT-Uthmani','Amiri Quran','Amiri',serif;
        --paper: #f6f1e4; --paper-2: #efe8d6; --ink: #1f1d18; --ink-2: #5e584b; --ink-3: #a39b86;
        --rule: #ddd3bc; --green: #1f5f4b; --gilt: #a8802a; --wash: rgba(168,128,42,.20);
        --shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 18px 50px -12px rgba(20,16,6,.55), 0 2px 6px rgba(20,16,6,.25);
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --paper: #181713; --paper-2: #211f1a; --ink: #ece5d3; --ink-2: #aaa28f; --ink-3: #6b6557;
          --rule: #35322a; --green: #7cc4a6; --gilt: #d8b25e; --wash: rgba(216,178,94,.20);
          --shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 50px -12px rgba(0,0,0,.8), 0 2px 6px rgba(0,0,0,.5);
        }
      }
      /* Ambient: the card takes a deep tint of the video's colours, so the
         text tokens switch to their light-on-dark set. */
      :host([data-ambient]) {
        --paper: #1b1a17; --paper-2: rgba(255,255,255,.07); --ink: #f5f1e8; --ink-2: rgba(245,241,232,.74);
        --ink-3: rgba(245,241,232,.42); --rule: rgba(255,255,255,.14); --green: #a5e3c8; --gilt: #ecc97a;
        --wash: rgba(236,201,122,.24);
        --shadow: 0 1px 0 rgba(255,255,255,.07) inset, 0 18px 50px -12px rgba(0,0,0,.8), 0 2px 6px rgba(0,0,0,.5);
        transition: --qlt-g1 1.4s ease, --qlt-g2 1.4s ease;
      }
      :host([data-ambient]) .card { background: linear-gradient(135deg, var(--qlt-g1, #1b1a17), var(--qlt-g2, #1b1a17)); }
      * { box-sizing: border-box; margin: 0; }
      .card {
        position: relative; width: var(--card-w); max-width: calc(100vw - 16px);
        background: var(--paper); color: var(--ink);
        border: 1px solid var(--rule); border-radius: 18px; overflow: hidden;
        box-shadow: var(--shadow);
        font-family: 'QLT-Text', system-ui, -apple-system, 'Segoe UI', sans-serif;
      }

      /* Passage ribbon: where we are in the video, with a notch per ayah. */
      .ribbon { position: relative; height: 14px; cursor: pointer; background: var(--paper-2); border-bottom: 1px solid var(--rule); }
      .ribbon .span { position: absolute; top: 6px; height: 2px; background: var(--ink-3); opacity: .55; border-radius: 1px; }
      .ribbon[data-mode="cpu"] .span { background: var(--green); opacity: .7; }
      .ribbon .tick { position: absolute; top: 4px; width: 1px; height: 6px; background: var(--ink-3); }
      .ribbon .fill { position: absolute; top: 6px; left: 0; height: 2px; background: var(--green); border-radius: 1px; }
      .ribbon .head { position: absolute; top: 3px; width: 2px; height: 8px; margin-left: -1px; background: var(--green); border-radius: 1px; }
      .ribbon-label { position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 14px; color: var(--ink-2); pointer-events: none; }
      .sync-note { padding: 5px 14px 0; font-size: 11px; color: var(--ink-2); }

      .bar { display: flex; align-items: center; gap: 6px; padding: 9px 8px 0 14px; cursor: grab; user-select: none; }
      .bar:active { cursor: grabbing; }
      .where {
        flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font: 600 10.5px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
        letter-spacing: .09em; text-transform: uppercase; color: var(--ink-2);
      }
      .where b { color: var(--green); font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .04em; }
      .live { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); margin-right: 7px; vertical-align: 1px; }
      .live.wait { background: var(--gilt); }
      .live.err { background: #b3402e; }
      .ctl { display: flex; align-items: center; position: relative; z-index: 8; }
      .ctl button {
        all: unset; cursor: pointer; width: 26px; height: 24px; display: grid; place-items: center;
        color: var(--ink-2); border-radius: 6px;
      }
      .ctl button:hover { background: var(--paper-2); color: var(--ink); }
      .ctl button:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
      .ctl svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .ctl .sep { width: 1px; height: 14px; background: var(--rule); margin: 0 3px; }

      .body { padding: 6px 18px 16px; }
      .status { font-size: 14px; line-height: 1.5; color: var(--ink-2); padding: 8px 0 2px; }
      .restart-cpu { margin-top: 10px; padding: 8px 14px; border: 1px solid var(--green); border-radius: 8px; background: var(--wash); color: var(--ink); font: inherit; cursor: pointer; }
      .restart-cpu:disabled { cursor: wait; }
      .diag { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--rule); color: var(--ink-3);
        font: 500 10.5px/1.4 'QLT-Text', system-ui, sans-serif; overflow-wrap: anywhere; }
      .arabic {
        direction: rtl; text-align: right; font-family: var(--ar-font);
        font-size: var(--ar-size); line-height: 2.05; color: var(--ink); padding-top: 2px;
      }
      .arabic .w { color: var(--ink-3); border-radius: 5px; padding: 0 1px; transition: color .18s ease, background-color .18s ease; }
      .arabic .w.done { color: var(--ink); }
      .arabic .w.cur { color: var(--ink); background: var(--wash); box-shadow: 0 0 0 2px var(--wash); }
      /* Ayah number in its own drawn ring: fonts disagree on whether the
         end-of-ayah sign encloses its digits, so we don't rely on it. */
      .arabic .end { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
        min-width: 1.9em; height: 1.9em; padding: 0 .3em; margin-right: .35em; vertical-align: middle;
        border: 1.5px solid var(--gilt); border-radius: 999px; color: var(--gilt);
        font: 600 .46em/1 'QLT-Text', system-ui, sans-serif; direction: rtl; }
      .trans { font-size: 15px; line-height: 1.5; color: var(--ink-2); margin-top: 6px; text-wrap: pretty;
        font-family: 'QLT-Text', 'QLT-IndoPak', system-ui, 'Segoe UI', 'Nirmala UI', sans-serif; }
      .trans:lang(ur) { font-size: 17px; line-height: 1.9; }
      .next { margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--rule); }
      .next .lbl { font: 600 9.5px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }
      .next .arabic { font-size: calc(var(--ar-size) * .72); line-height: 1.95; color: var(--ink-3); padding-top: 3px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .hidden { display: none !important; }
      .card.pip { width: 100%; max-width: none; min-height: 100vh; border: 0; border-radius: 0; box-shadow: none; }
      .card.pip .bar { cursor: default; }
      .card.pip .rz { display: none; }

      .rz { position: absolute; z-index: 6; }
      .rz.e { right: 0; top: 30px; bottom: 14px; width: 7px; cursor: ew-resize; }
      .rz.w { left: 0; top: 30px; bottom: 14px; width: 7px; cursor: ew-resize; }
      .rz.se { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; }
      .rz.sw { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; }
      @media (prefers-reduced-motion: reduce) { .arabic .w { transition: none; } }
    </style>
    <div class="card" role="complementary" aria-label="Quran verse">
      <div class="ribbon hidden" id="ribbon" title="Jump to an ayah">
        <div id="spans"></div><div class="fill" id="fill"></div><div class="head" id="head"></div>
      </div>
      <div class="bar" id="bar">
        <div class="where" id="where">Ayah Sync</div>
        <div class="ctl">
          <span id="seek" class="hidden" style="display:flex;align-items:center">
            <button id="prev" title="Previous ayah" aria-label="Previous ayah"><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button>
            <button id="again" title="Repeat this ayah" aria-label="Repeat this ayah"><svg viewBox="0 0 16 16"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5"/><path d="M3 2.6v2.6h2.6"/></svg></button>
            <button id="nextBtn" title="Next ayah" aria-label="Next ayah"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button>
            <span class="sep"></span>
          </span>
          <button id="playBtn" title="Pause" aria-label="Pause">
            <svg id="icoPause" viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>
            <svg id="icoPlay" class="hidden" viewBox="0 0 16 16"><path d="M5.5 3.5v9l7-4.5z" fill="currentColor"/></svg>
          </button>
          <button id="pop" title="Keep on top of other tabs and apps" aria-label="Keep on top"><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="9" rx="1.5"/><rect x="8" y="7.5" width="4" height="3" rx=".6" fill="currentColor" stroke="none"/></svg></button>
          <button id="close" title="Close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
        </div>
      </div>
      <div class="body">
        <div class="status" id="status">Starting…</div>
        <button class="restart-cpu hidden" id="restartCpu">Sync this video</button>
        <div id="verse" class="hidden">
          <div class="arabic" id="arabic" lang="ar"></div>
          <div class="trans" id="trans" dir="auto"></div>
          <div class="diag hidden" id="debug"></div>
          <div class="next hidden" id="nextWrap">
            <div class="lbl">Next</div>
            <div class="arabic" id="nextArabic" lang="ar"></div>
          </div>
        </div>
      </div>
      <div class="rz w" data-dir="w"></div><div class="rz e" data-dir="e"></div>
      <div class="rz sw" data-dir="sw"></div><div class="rz se" data-dir="se"></div>
    </div>`;

  document.documentElement.appendChild(host);
  const $ = (id) => shadow.getElementById(id);
  els = {
    ribbon: $('ribbon'), spans: $('spans'), fill: $('fill'), head: $('head'),
    bar: $('bar'), where: $('where'), seek: $('seek'),
    prev: $('prev'), again: $('again'), next: $('nextBtn'), close: $('close'), pop: $('pop'), play: $('playBtn'), icoPlay: $('icoPlay'), icoPause: $('icoPause'), card: shadow.querySelector('.card'),
    status: $('status'), restartCpu: $('restartCpu'), verse: $('verse'), arabic: $('arabic'), trans: $('trans'), debug: $('debug'),
    nextWrap: $('nextWrap'), nextArabic: $('nextArabic'),
  };

  els.close.addEventListener('click', () => {
    if (tl) {
      clearTimeline();
      runtimeMessage({ type: 'SYNC_CLEAR' }).catch(() => {});
    } else {
      runtimeMessage({ type: 'STOP' }).catch(() => {});
    }
    hideCard();
  });
  els.pop.addEventListener('click', togglePip);
  els.play.addEventListener('click', toggleMedia);
  els.restartCpu.addEventListener('click', async () => {
    if (!browserCPU || els.restartCpu.disabled) return;
    els.restartCpu.disabled = true;
    els.restartCpu.textContent = 'Starting CPU sync…';
    try {
      const result = await runtimeMessage({ type: 'CPU_RESTART_VIDEO' });
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      if (!els) return;
      setStatus(error.message || 'Could not start CPU sync.', 'err');
      els.restartCpu.disabled = false;
      els.restartCpu.textContent = 'Try CPU sync again';
      els.restartCpu.classList.remove('hidden');
    }
  });
  els.prev.addEventListener('click', () => seekAyah(-1));
  els.again.addEventListener('click', () => seekAyah(0));
  els.next.addEventListener('click', () => seekAyah(1));
  els.ribbon.addEventListener('click', (e) => {
    const v = findVideo();
    if (!v || (!tl && (!cpuBuffer || videoKey(location.href) !== cpuBuffer.key))) return;
    const r = els.ribbon.getBoundingClientRect();
    const duration = tl?.duration ?? cpuBuffer.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const t = Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
    // Snap to the start of the ayah under the pointer.
    if (tl) {
      const i = ayahIndexAt(t);
      v.currentTime = Math.max(0, (i >= 0 ? tl.ayahs[i].t0 : t) - 0.05);
    } else v.currentTime = t;
  });

  // Resize from either side edge or the bottom corners (height follows content).
  let rz = null;
  shadow.querySelectorAll('.rz').forEach((h) => {
    h.addEventListener('mousedown', (e) => {
      const r = host.getBoundingClientRect();
      const west = h.dataset.dir.includes('w');
      rz = { west, fixedX: west ? r.right : r.left };
      host.style.left = `${r.left}px`;
      host.style.top = `${r.top}px`;
      host.style.right = 'auto';
      e.preventDefault();
      e.stopPropagation();
    });
  });
  // Drag by the header.
  els.bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.ctl')) return;
    const r = host.getBoundingClientRect();
    dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!host) return;
    if (rz) {
      if (rz.west) {
        cardWidth = Math.round(Math.min(760, Math.max(280, rz.fixedX - e.clientX)));
        host.style.left = `${rz.fixedX - cardWidth}px`;
      } else {
        cardWidth = Math.round(Math.min(760, Math.max(280, e.clientX - rz.fixedX)));
      }
      host.style.setProperty('--card-w', `${cardWidth}px`);
    } else if (dragState) {
      host.style.left = `${e.clientX - dragState.dx}px`;
      host.style.top = `${e.clientY - dragState.dy}px`;
      host.style.right = 'auto';
    }
  }, { signal: contentLifecycle.signal });
  window.addEventListener('mouseup', () => {
    if (!extensionAvailable()) return;
    if (!host || (!rz && !dragState)) return;
    const save = { cardPos: { left: host.style.left, top: host.style.top } };
    if (rz) save.qltCardWidth = cardWidth;
    rz = null;
    dragState = null;
    if (host.style.left) chrome.storage?.local.set(save);
  }, { signal: contentLifecycle.signal });

  applyPrefs();
  installFonts(window);
  registerAmbientProps(window);
  paintAmbient(true);
  chrome.storage?.local.get('cardPos', (v) => {
    const p = v?.cardPos;
    if (!p || !host || !p.left) return;
    const left = Math.min(Math.max(parseInt(p.left, 10) || 0, 0), window.innerWidth - 200);
    const top = Math.min(Math.max(parseInt(p.top, 10) || 0, 0), window.innerHeight - 100);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = 'auto';
  });
}

/** Pause or resume the recitation from the card. In synced mode the video is
 *  on this page; in live mode it may be in another tab, so ask the worker. */
function toggleMedia() {
  const v = tl ? findVideo() : null;
  if (v) {
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  } else {
    runtimeMessage({ type: 'MEDIA_TOGGLE' }).catch(() => {});
  }
}

let playShown = null;
function setPlayIcon(playing) {
  if (!els || playShown === playing) return;
  playShown = playing;
  els.icoPause.classList.toggle('hidden', !playing);
  els.icoPlay.classList.toggle('hidden', playing);
  els.play.title = playing ? 'Pause' : 'Play';
  els.play.setAttribute('aria-label', els.play.title);
}

// Pop the card into an always-on-top window so it stays visible over other
// tabs and other applications; closing that window puts it back on the page.
function togglePip() {
  if (!host) return;
  if (!inPip) {
    const r = host.getBoundingClientRect();
    host.dataset.pipW = Math.round(Math.max(320, r.width));
    host.dataset.pipH = Math.round(Math.max(220, r.height + 8));
    delete host.dataset.pipGone;
  }
  // Handled synchronously by pip-bridge.js in the page's script world, so this
  // click still counts as the gesture Chrome requires.
  document.dispatchEvent(new Event('qlt-pip-toggle'));
}

document.addEventListener('qlt-pip-opened', () => {
  if (!host) return;
  inPip = true;
  host.dataset.pos = host.style.cssText;
  host.style.cssText =
    'all:initial; display:block;' +
    ['--ar-size', '--card-w', '--ar-font', '--qlt-g1', '--qlt-g2']
      .map((k) => `${k}:${host.style.getPropertyValue(k)};`)
      .join('');
  els.card.classList.add('pip');
  restartLoops();
}, { signal: contentLifecycle.signal });
document.addEventListener('qlt-pip-closed', () => {
  inPip = false;
  if (!host || host.dataset.pipGone) return;
  host.style.cssText = host.dataset.pos || '';
  els.card.classList.remove('pip');
  applyPrefs();
  restartLoops();
}, { signal: contentLifecycle.signal });
document.addEventListener('qlt-pip-error', () => {
  if (els) els.pop.title = 'Floating window is not available in this browser';
}, { signal: contentLifecycle.signal });
// Keys pressed in the floating window: space pauses, arrows step through ayahs.
document.addEventListener('qlt-pip-key', () => {
  const key = host?.dataset.pipKey;
  if (key === 'space') toggleMedia();
  else if (key === 'prev') seekAyah(-1);
  else if (key === 'next') seekAyah(1);
}, { signal: contentLifecycle.signal });

function restartLoops() {
  caf(tlRaf);
  caf(liveRaf);
  tlRaf = liveRaf = null;
  if (tl) tlRaf = raf(tlTick);
  if (liveMatch && !browserCPU) liveRaf = raf(liveTick);
  caf(bufferRaf);
  bufferRaf = cpuBuffer ? raf(bufferTick) : null;
}

function hideCard() {
  caf(bufferRaf);
  bufferRaf = null;
  cpuBuffer = null;
  cpuSegments.clear();
  bufferedRef = null;
  if (inPip && host) {
    host.dataset.pipGone = '1';
    inPip = false;
    document.dispatchEvent(new Event('qlt-pip-toggle')); // closes the window
  }
  caf(liveRaf);
  liveRaf = null;
  liveMatch = null;
  clearTimeout(highlightTimer);
  shown = null;
  builtText = '';
  wordEls = [];
  playShown = null;
  clearInterval(ambientTimer);
  ambientTimer = null;
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = shadow = els = null;
}

function setStatus(text, tone) {
  if (!els) return;
  els.verse.classList.add('hidden');
  els.status.classList.remove('hidden');
  els.status.textContent = text;
  els.restartCpu.classList.add('hidden');
  els.where.innerHTML = `<span class="live ${tone || 'wait'}"></span>Ayah Sync`;
  shown = null;
  builtText = '';
}

// =================================================================== ambient
// Sample the video (or, failing that, the page) and tint the card to match.
let ambientTimer = null;
let ambientCanvas = null;

function registerAmbientProps(win) {
  for (const name of ['--qlt-g1', '--qlt-g2']) {
    try {
      win.CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue: '#1b1a17' });
    } catch {} // already registered
  }
}

/** Keep the hue, cap the saturation and pull the lightness down so light text
 *  stays readable on top. */
function deepen([r, g, b], light) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `hsl(${h.toFixed(0)} ${(Math.min(sat, 0.5) * 100).toFixed(0)}% ${light}%)`;
}

function sampleVideo() {
  const v = findVideo();
  if (!v || v.tagName !== 'VIDEO' || !v.videoWidth) return null;
  try {
    ambientCanvas ||= document.createElement('canvas');
    ambientCanvas.width = ambientCanvas.height = 8;
    const ctx = ambientCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 8, 8);
    const px = ctx.getImageData(0, 0, 8, 8).data; // throws if the video is cross-origin
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        const t = x + y < 8 ? a : b; // top-left half vs bottom-right half
        t[0] += px[i]; t[1] += px[i + 1]; t[2] += px[i + 2];
      }
    }
    const na = 36;
    const nb = 28;
    return [a.map((c) => c / na), b.map((c) => c / nb)];
  } catch {
    return null;
  }
}

function samplePage() {
  for (const el of [document.body, document.documentElement]) {
    const m = el && getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    if (m && (m.length < 4 || Number(m[3]) > 0.5)) {
      const c = m.slice(0, 3).map(Number);
      return [c, c];
    }
  }
  return null;
}

function paintAmbient(restart) {
  if (restart) {
    clearInterval(ambientTimer);
    ambientTimer = null;
  }
  if (!host) return;
  if (!ambient) {
    host.removeAttribute('data-ambient');
    return;
  }
  const cols = sampleVideo() || samplePage();
  if (cols) {
    host.setAttribute('data-ambient', '');
    host.style.setProperty('--qlt-g1', deepen(cols[0], 20));
    host.style.setProperty('--qlt-g2', deepen(cols[1], 12));
  }
  ambientTimer ||= setInterval(() => paintAmbient(false), 1200);
}

// ============================================================ render an ayah
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);
// Timelines cached before the text was cleaned can still carry private-use
// pause signs (only quran.com's own font draws them) and invisible marks.
const clean = (t) => t.replace(/[-​-‏﻿]/g, '').replace(/[  ]/g, ' ');
const arabicOf = (a) => clean(script === 'indopak' && a.arabicIndopak ? a.arabicIndopak : a.arabic || '');

/** English comes with the ayah; other languages are fetched from the extension's
 *  own bundled files (through the service worker) and fall back to English
 *  until they arrive. */
const translationOf = (a) => (lang !== 'en' && trMap[a.ref]) || a.translation || '';

function loadTranslations(refs) {
  refs = [...new Set(refs.filter((r) => r && !trMap[r]))];
  if (lang === 'en' || !refs.length) return;
  const asked = lang;
  runtimeMessage({ type: 'TR_GET', lang, refs })
    .then((r) => {
      if (!r?.map || asked !== lang) return;
      Object.assign(trMap, r.map);
      rerender();
    })
    .catch(() => {});
}

/** Build the card for `a` (only when it differs from what is shown). */
function renderAyah(a, next) {
  ensureCard();
  const text = arabicOf(a);
  if (shown && shown.ref === a.ref && text === builtText && shown.__next?.ref === next?.ref) {
    a.__next = next;
    shown = a;
    return;
  }
  if (lang !== 'en' && !trMap[a.ref]) loadTranslations([a.ref, next?.ref]);
  a.__next = next;
  shown = a;
  builtText = text;

  els.status.classList.add('hidden');
  els.restartCpu.classList.add('hidden');
  els.verse.classList.remove('hidden');
  const meta = a.surahMeta || {};
  const name = meta.englishName || `Surah ${a.surah}`;
  els.where.innerHTML = a.basmala
    ? `<span class="live"></span>${name} <b>· opening</b>`
    : `<span class="live"></span>${name} <b>${a.surah}:${a.ayah}</b>`;
  els.where.title = meta.englishNameTranslation || '';

  els.arabic.textContent = '';
  const words = text.split(/\s+/).filter(Boolean);
  wordEls = words.map((w) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = w;
    els.arabic.append(span, ' ');
    return span;
  });
  if (!a.basmala) {
    const end = document.createElement('span');
    end.className = 'end';
    end.textContent = arNum(a.ayah);
    els.arabic.append(end);
  }

  const tr = translationOf(a);
  els.trans.textContent = tr;
  els.trans.lang = lang;
  els.trans.classList.toggle('hidden', !showTranslation || !tr || !!a.basmala);

  const nextText = next ? arabicOf(next) : '';
  els.nextWrap.classList.toggle('hidden', !nextText);
  if (nextText) els.nextArabic.textContent = nextText;
  if (browserCPU && !cpuHighlight && !tl) paintWords(Infinity);
}

/** cur = index of the word being recited (-1: none yet, Infinity: all done). */
function paintWords(cur) {
  if (browserCPU && !cpuHighlight && !tl) cur = Infinity;
  const indices = Array.isArray(cur) ? cur : null;
  const first = indices ? indices[0] : cur;
  for (let i = 0; i < wordEls.length; i++) {
    const el = wordEls[i];
    const state = (indices ? indices.includes(i) : i === cur) ? 2 : browserCPU && !tl ? 1 : i < first ? 1 : 0;
    if (el._s === state) continue;
    el._s = state;
    el.classList.toggle('done', state === 1);
    el.classList.toggle('cur', state === 2);
  }
}

// =============================================================== synced mode
function videoKey(href) {
  try {
    const u = new URL(href);
    const yt =
      (/(^|\.)youtube\.com$/.test(u.hostname) && (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1])) ||
      (u.hostname === 'youtu.be' && u.pathname.slice(1, 12));
    return yt ? `yt:${yt}` : u.origin + u.pathname;
  } catch {
    return href;
  }
}

function findVideo() {
  let best = null;
  let bestArea = -1;
  for (const m of document.querySelectorAll('video, audio')) {
    if (!isFinite(m.duration) || m.duration <= 0) continue;
    const r = m.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = m;
      bestArea = area;
    }
  }
  return best;
}

function ayahIndexAt(t, a = tl?.ayahs || []) {
  let lo = 0;
  let hi = a.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t0 <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function clock(t) {
  t = Math.max(0, Math.round(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function loadTimeline(timeline) {
  if (!timeline?.ayahs?.length) return;
  clearTimeout(highlightTimer);
  caf(liveRaf);
  liveRaf = null;
  liveMatch = null;
  tl = timeline;
  cpuSegments.clear();
  tlIdx = -2;
  lastHref = location.href;
  ensureCard();
  loadTranslations(tl.ayahs.map((a) => a.ref));
  els.seek.classList.remove('hidden');
  els.ribbon.classList.remove('hidden');
  delete els.ribbon.dataset.mode;
  els.ribbon.title = 'Jump to an ayah';
  for (const button of [els.prev, els.again, els.next]) button.disabled = false;
  els.prev.title = 'Previous ayah';
  els.again.title = 'Repeat this ayah';
  els.next.title = 'Next ayah';
  // Ribbon: a line per recited passage, a notch at each ayah start.
  const pct = (t) => `${Math.min(100, (t / tl.duration) * 100).toFixed(3)}%`;
  els.spans.textContent = '';
  for (const p of tl.passages || []) {
    const s = document.createElement('div');
    s.className = 'span';
    s.style.left = pct(p.t0);
    s.style.width = pct(p.t1 - p.t0);
    els.spans.append(s);
  }
  for (const a of tl.ayahs) {
    const k = document.createElement('div');
    k.className = 'tick';
    k.style.left = pct(a.t0);
    els.spans.append(k);
  }
  caf(tlRaf);
  tlRaf = raf(tlTick);
}

function clearTimeline() {
  caf(tlRaf);
  tlRaf = null;
  tl = null;
  tlIdx = -2;
  if (els) {
    els.seek.classList.add('hidden');
    els.ribbon.classList.add('hidden');
  }
}

function tlTick() {
  if (!extensionAvailable()) return;
  if (!tl) return;
  tlRaf = raf(tlTick);

  // Single-page sites swap videos without reloading: a new URL means this
  // timeline no longer describes what is playing.
  if (location.href !== lastHref) {
    if (videoKey(location.href) !== videoKey(lastHref)) {
      clearTimeline();
      hideCard();
      helloTimeline();
      return;
    }
    lastHref = location.href;
  }

  const v = findVideo();
  if (!v || !els) return;
  // Something else is in the player (an ad, the next video): don't pretend.
  if (Math.abs(v.duration - tl.duration) > 5) {
    if (tlIdx !== -3) {
      tlIdx = -3;
      setStatus('Waiting for the video to play…', 'wait');
    }
    return;
  }

  setPlayIcon(!v.paused);
  const t = v.currentTime + LEAD_S;
  const i = ayahIndexAt(t);
  els.fill.style.width = els.head.style.left = `${Math.min(100, (v.currentTime / tl.duration) * 100)}%`;

  if (i < 0) {
    // Before the first ayah: show what is coming.
    const first = tl.ayahs[0];
    renderAyah(first, tl.ayahs[1] || null);
    paintWords(-1);
    tlIdx = -1;
    return;
  }
  const a = tl.ayahs[i];
  renderAyah(a, tl.ayahs[i + 1] || null);
  tlIdx = i;

  // Word under the playhead (last word whose start has passed).
  const w = a.w;
  let wi = -1;
  for (let k = 0; k < w.length; k++) {
    if (w[k] <= t) wi = k;
    else break;
  }
  // A long gap after the ayah (next rak'ah, a pause): everything is recited.
  if (t > a.t1 + 0.6) wi = Infinity;
  // The IndoPak script occasionally splits words differently: scale the index.
  if (wi !== Infinity && wi >= 0 && wordEls.length !== w.length && w.length > 1) {
    wi = Math.round((wi * (wordEls.length - 1)) / (w.length - 1));
  }
  paintWords(wi);
}

function seekAyah(dir) {
  const v = findVideo();
  const entries = tl?.ayahs;
  if (!entries?.length || !v) return;
  const t = v.currentTime + LEAD_S;
  let i = ayahIndexAt(t);
  if (dir === 0) i = Math.max(0, i);
  else if (dir < 0) i = i <= 0 ? 0 : t - entries[i].t0 > 2 ? i : i - 1;
  else i = Math.min(entries.length - 1, i + 1);
  v.currentTime = Math.max(0, entries[i].t0 - (tl ? 0.05 : 0));
  if (v.paused && dir === 0) v.play().catch(() => {});
}

/** Ask the service worker whether this page's video already has a timeline. */
function helloTimeline() {
  runtimeMessage({ type: 'TL_HELLO', url: location.href })
    .then((r) => {
      if (r?.timeline) loadTimeline(r.timeline);
    })
    .catch(() => {});
}

// ================================================================= live mode
function showLive(m) {
  liveMatch = m;
  const ayahChanged = !shown || shown.ref !== m.ref;
  renderAyah(m, m.next || null);
  if (browserCPU) {
    caf(liveRaf);
    liveRaf = null;
    paintCpuHighlight(m.highlight);
    return;
  }
  const now = performance.now();
  if (ayahChanged) {
    prevWord = m.word || 0;
    prevTime = now;
    rate = 1.0;
    shownWord = m.word || 0;
  } else {
    const dt = (now - prevTime) / 1000;
    const dw = (m.word || 0) - prevWord;
    if (dt > 0.5 && dw > 0) rate = Math.min(3, Math.max(0.4, rate * 0.5 + (dw / dt) * 0.5));
    prevWord = m.word || 0;
    prevTime = now;
  }
  anchorWord = m.word || 0;
  anchorTime = now;
  if (liveRaf == null) {
    shownWord = anchorWord;
    paintWords(shownWord);
    liveRaf = raf(liveTick);
  }
}

function paintCpuHighlight(highlight) {
  clearTimeout(highlightTimer);
  highlightTimer = null;
  const remaining = (highlight?.expiresAt || 0) - Date.now();
  if (!cpuHighlight || !highlight || highlight.ref !== liveMatch?.ref || highlight.word < 0 || remaining <= 0) {
    paintWords(Infinity);
    return;
  }
  // No rate extrapolation: show only the last acoustically supported word.
  // Expiry includes inference/transport latency and clears silence/stale work.
  const indices = displayWordIndices(liveMatch.arabic, builtText, highlight.word);
  shownWord = indices[0] ?? -1;
  if (!indices.length) return paintWords(Infinity);
  paintWords(indices);
  highlightTimer = setTimeout(() => paintWords(Infinity), Math.min(remaining, 1000));
}

function liveTick() {
  if (!extensionAvailable()) return;
  if (!els || !liveMatch || wordEls.length === 0) {
    liveRaf = null;
    return;
  }
  liveRaf = raf(liveTick);
  if (!mediaPlaying) {
    anchorTime = performance.now(); // resume from here, no jump
    return;
  }
  const elapsed = performance.now() - anchorTime;
  const drift = elapsed > MAX_DRIFT_MS ? 0 : (elapsed / 1000) * rate;
  const target = Math.min(anchorWord + drift, anchorWord + MAX_LEAD, wordEls.length - 1);
  shownWord = Math.min(Math.max(shownWord, Math.floor(target)), wordEls.length - 1); // forward only
  paintWords(shownWord);
}

function renderCpuTimeline() {
  if (!els || !cpuBuffer || !Number.isFinite(cpuBuffer.duration) || cpuBuffer.duration <= 0) return;
  const pct = (t) => `${Math.max(0, Math.min(100, t / cpuBuffer.duration * 100)).toFixed(3)}%`;
  els.ribbon.dataset.mode = 'cpu';
  els.ribbon.title = 'CPU processed sections · click to seek';
  els.ribbon.classList.toggle('hidden', videoKey(location.href) !== cpuBuffer.key);
  els.fill.style.width = '0%'; // Never paint unprocessed gaps as recognized.
  const signature = `${cpuBuffer.key}:${cpuBuffer.duration}:${(cpuBuffer.ranges || []).map((r) => r.id).join(',')}:${(cpuBuffer.marks || []).join(',')}`;
  if (els.cpuTimelineSignature === signature) {
    const spans = els.spans.querySelectorAll('.span');
    for (let i = 0; i < spans.length; i++) {
      const range = cpuBuffer.ranges[i];
      spans[i].style.left = pct(range.from);
      spans[i].style.width = pct(Math.min(cpuBuffer.duration, range.until) - range.from);
      spans[i].title = `Processed ${clock(range.from)}–${clock(range.until)}`;
    }
    return;
  }
  els.cpuTimelineSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const range of cpuBuffer.ranges || []) {
    const span = document.createElement('div');
    span.className = 'span';
    span.style.left = pct(range.from);
    span.style.width = pct(Math.min(cpuBuffer.duration, range.until) - range.from);
    span.title = `Processed ${clock(range.from)}–${clock(range.until)}`;
    fragment.append(span);
  }
  for (const time of cpuBuffer.marks || []) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = pct(time);
    fragment.append(tick);
  }
  els.spans.replaceChildren(fragment);
}

function bufferTick() {
  if (!extensionAvailable()) return;
  if (!cpuBuffer || !els) { bufferRaf = null; return; }
  bufferRaf = raf(bufferTick);
  const v = findVideo();
  if (!v) return;
  if (!Number.isFinite(cpuBuffer.duration) || cpuBuffer.duration <= 0) return;
  const t = v.currentTime;
  els.ribbon.classList.toggle('hidden', videoKey(location.href) !== cpuBuffer.key);
  els.head.style.left = `${Math.max(0, Math.min(100, t / cpuBuffer.duration * 100))}%`;
  const valid = videoKey(location.href) === cpuBuffer.key &&
    Math.abs(v.duration - cpuBuffer.duration) <= 5 && !v.seeking;
  const cue = valid && cpuBuffer.ready === true && t >= (cpuBuffer.cueFrom ?? cpuBuffer.from) && t <= (cpuBuffer.cueUntil ?? cpuBuffer.until) + 0.5
    ? cpuBuffer.cues[ayahIndexAt(t, cpuBuffer.cues)] : null;
  setPlayIcon(!v.paused);
  if (!cue) {
    const text = videoKey(location.href) === cpuBuffer.key
      ? cpuBuffer.ready !== true
        ? `CPU sync · preparing first ${Math.ceil(cpuBuffer.requiredSeconds || 12)}s · ${Math.floor(cpuBuffer.preparedSeconds || 0)}s recognized…`
        : 'CPU look-ahead · preparing this position…'
      : 'Video changed — start CPU sync again.';
    if (shown || els.status.textContent !== text) setStatus(text, 'wait');
    if (!valid && videoKey(location.href) !== cpuBuffer.key && browserCPU) {
      els.restartCpu.classList.remove('hidden');
    }
    return;
  }
  const changed = shown?.ref !== cue.match.ref;
  liveMatch = cue.match;
  renderAyah(cue.match, cue.match.next);
  const timing = displayTiming(cue);
  const span = cpuHighlight ? timing.findLast((w) => w.start <= t && t < w.end) : null;
  const word = span?.word ?? -1;
  if (changed || word !== bufferedWord) {
    bufferedWord = word;
    const display = displayWordIndices(cue.match.arabic, builtText, word);
    paintWords(display.length ? display : Infinity);
  }
  if (bufferedRef !== cue.match.ref) {
    bufferedRef = cue.match.ref;
    runtimeMessage({ type: 'BUFFER_POSITION', match: cue.match,
      captureEpoch: cpuBuffer.captureEpoch }).catch(() => {});
  }
}

// Reports this page's play/pause so the live estimate freezes with the video.
let mediaArmed = false;
let reportedPlaying = null;
function reportMedia() {
  if (!extensionAvailable()) return;
  let playing = false;
  for (const m of document.querySelectorAll('video, audio')) {
    if (!m.paused && !m.ended && m.readyState >= 2) playing = true;
  }
  if (playing !== reportedPlaying) {
    reportedPlaying = playing;
    runtimeMessage({ type: 'MEDIA_STATE', playing }).catch(() => {});
  }
}
function armMediaWatch() {
  if (mediaArmed) return reportMedia();
  mediaArmed = true;
  document.addEventListener('seeking', (event) => {
    if (!extensionAvailable()) return;
    if (!event.target?.matches?.('video, audio') || tl) return;
    const following = !!liveMatch;
    if (cpuBuffer && videoKey(location.href) === cpuBuffer.key) {
      const time = event.target.currentTime;
      const requiredSeconds = Math.min(CPU_LOOKAHEAD_SECONDS, Math.max(0, cpuBuffer.duration - time));
      const cached = [...cpuSegments.values()].find((s) => s.ready && time >= (s.cueFrom ?? s.from) && time <= (s.cueUntil ?? s.until) &&
        s.until >= time + requiredSeconds - 0.001);
      cpuBuffer = cached ? { ...cached, ranges: cpuBuffer.ranges, marks: cpuBuffer.marks }
        : { ...cpuBuffer, from: null, until: null, cues: [], ready: false, preparedSeconds: 0, requiredSeconds };
    }
    bufferedRef = null;
    caf(bufferRaf);
    bufferRaf = null;
    liveMatch = null;
    clearTimeout(highlightTimer);
    shownWord = -1;
    shown = null;
    paintWords(-1);
    if (following && !cpuBuffer?.ready) setStatus('Identifying the new passage…', 'wait');
    if (cpuBuffer) bufferRaf = raf(bufferTick);
    runtimeMessage({ type: 'CAPTURE_RESET', time: event.target.currentTime }).catch(() => {});
  }, { capture: true, signal: contentLifecycle.signal });
  mediaTimer = setInterval(reportMedia, 500);
  reportMedia();
}

const LIVE_STATUS = {
  'loading-model': 'Connecting to the helper…',
  listening: 'Listening for recitation…',
  stopped: 'Stopped.',
};
const liveStatus = (status) => browserCPU && cpuBufferedMode
  ? status === 'loading-model' ? 'CPU sync · preparing audio…' : status === 'listening' ? 'CPU sync · preparing upcoming ayahs…' : LIVE_STATUS[status] || ''
  : browserCPU && status === 'listening' ? 'Listening live · identifying recitation…'
  : status === 'loading-model' && browserCPU ? 'Listening live · loading CPU model…' : LIVE_STATUS[status] || '';

// ================================================================== messages
function onRuntimeMessage(msg, _sender, sendResponse) {
  if (!extensionAvailable()) return;
  if (msg?.type === 'CONTENT_PING') {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'CAPTURE_CLOCK') {
    const v = findVideo();
    sendResponse(v ? { key: videoKey(location.href), href: location.href, src: v.currentSrc || v.src || '', time: v.currentTime, duration: v.duration,
      playbackRate: v.playbackRate, seeking: v.seeking, paused: v.paused } : null);
    return;
  }
  if (msg?.type === 'TL_MEDIA') {
    const v = findVideo();
    sendResponse({ src: v ? v.currentSrc || v.src || '' : '', duration: v ? v.duration : 0,
      time: v ? v.currentTime : 0, encrypted: !!v?.mediaKeys, href: location.href });
    return;
  }
  switch (msg?.type) {
    case 'TL_LOAD':
      loadTimeline(msg.timeline);
      break;
    case 'TL_CLEAR':
      clearTimeline();
      hideCard();
      break;
    case 'TL_PROGRESS':
      if (tl) break;
      ensureCard();
      setStatus(msg.text, msg.error ? 'err' : 'wait');
      break;

    case 'CARD_SHOW':
      if (tl) break;
      cpuBufferedMode = msg.mode === 'lookahead';
      ensureCard();
      setStatus(liveStatus(msg.status) || 'Starting…', 'wait');
      break;
    case 'CARD_STATUS':
      if (tl) break;
      ensureCard();
      if (msg.status === 'error') {
        cpuBuffer = null;
        caf(bufferRaf);
        bufferRaf = null;
        setStatus(msg.error || 'Something went wrong.', 'err');
      }
      else if (!shown) setStatus(msg.detail || liveStatus(msg.status), 'wait');
      break;
    case 'CARD_DEBUG':
      if (!DEV_MODE) break;
      if (tl) break;
      ensureCard();
      els.debug.textContent = msg.text || '';
      els.debug.classList.toggle('hidden', !msg.text);
      if (browserCPU && !cpuBufferedMode && !shown && msg.text) {
        setStatus(/^Listening live/i.test(msg.text) ? msg.text : `Listening live · ${msg.text}`, 'wait');
      }
      break;
    case 'CARD_UPDATE':
      if (!tl && !cpuBuffer && msg.match) showLive(msg.match);
      break;
    case 'CARD_HIGHLIGHT':
      if (!tl && browserCPU && liveMatch) {
        liveMatch = { ...liveMatch, highlight: msg.highlight };
        paintCpuHighlight(msg.highlight);
      }
      break;
    case 'CARD_BUFFER':
      if (tl || !msg.buffer) break;
      ensureCard();
      clearTimeout(highlightTimer);
      caf(liveRaf);
      liveRaf = null;
      if (cpuBuffer?.key !== msg.buffer.key) cpuSegments.clear();
      cpuBuffer = msg.buffer;
      if (cpuBuffer.segmentId != null) cpuSegments.set(cpuBuffer.segmentId, cpuBuffer);
      const retained = new Set((cpuBuffer.ranges || []).map((r) => r.id));
      for (const id of cpuSegments.keys()) if (!retained.has(id)) cpuSegments.delete(id);
      renderCpuTimeline();
      bufferedWord = -2;
      if (bufferRaf == null) bufferRaf = raf(bufferTick);
      break;
    case 'CARD_HIDE':
      if (!tl) hideCard();
      break;
    case 'CARD_MEDIA': {
      const was = mediaPlaying;
      mediaPlaying = msg.playing !== false;
      if (mediaPlaying && !was) anchorTime = performance.now();
      if (!tl) setPlayIcon(mediaPlaying);
      break;
    }
    case 'CARD_TOGGLE_MEDIA': {
      // Live mode: the card (possibly on another tab) asked this tab to pause/resume.
      const m = findVideo();
      if (m) {
        if (m.paused) m.play().catch(() => {});
        else m.pause();
      }
      break;
    }
    case 'CARD_WATCH_MEDIA':
      armMediaWatch();
      break;
  }
}
chrome.runtime.onMessage.addListener(onRuntimeMessage);

// Hand off cleanly if a rebuilt content bundle is injected into the same page.
document.dispatchEvent(new Event('qlt-content-replace'));
document.addEventListener('qlt-content-replace', disposeContent, { signal: contentLifecycle.signal });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) extensionAvailable();
}, { signal: contentLifecycle.signal });

// A reloaded page (or a tab opened before the extension) picks its sync back up.
helloTimeline();
