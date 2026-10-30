import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/brave-browser', headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
try {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
  const sw = await target.worker();
  await sw.evaluate(() => chrome.storage.local.set({ qltRecognition: 'browser' }));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(target.url()).host}/src/popup/popup.html`);
  await page.waitForFunction(() => document.querySelector('#recognition').value === 'browser');
  const activity = [{ at: Date.now(), key: 'session', text: 'Creating YouTube.js session…' },
    { at: Date.now(), key: 'download', text: 'Downloading audio · 37%' }];
  let state = { capturing: true, backend: 'lookahead', status: 'loading-model', cpuAudioSource: 'youtubejs', cpuAudioReady: false,
    preparationText: 'CPU sync · downloading audio in your browser · 37%…', debug: 'Starting YouTube.js',
    cpuActivity: activity, error: null, lastMatch: null, sync: { status: 'idle' } };
  const publish = async () => sw.evaluate((state) => chrome.runtime.sendMessage({ type: 'STATE', state }), state);
  await publish();
  await page.waitForFunction(() => !document.querySelector('#cpuActivity').hidden &&
    document.querySelector('#cpuActivityText').textContent.includes('37%'));
  assert.match(await page.$eval('#liveRef', (el) => el.textContent), /Preparing video audio/);
  assert.match(await page.$eval('#cpuActivitySource', (el) => el.textContent), /YouTube.js/);
  await page.click('#cpuActivity summary');
  assert.equal(await page.$$eval('#cpuActivityLog li', (els) => els.length), 2);
  assert.match(await page.$eval('#cpuActivityLog', (el) => el.textContent), /Downloading audio/);
  state = { ...state, cpuAudioReady: true, preparationText: 'CPU sync · loading CPU model…', modelProgress: { progress: 42 } };
  await publish();
  await page.waitForFunction(() => document.querySelector('#cpuActivityMetrics').textContent.includes('42%'));
  assert.match(await page.$eval('#liveNote', (el) => el.textContent), /First audio batch downloaded/);
  state = { ...state, status: 'listening', preparationText: null, debug: 'Recognizing ahead · 100ms',
    buffered: { ready: false, preparedSeconds: 5, requiredSeconds: 12 } };
  await publish();
  await page.waitForFunction(() => document.querySelector('#cpuActivityMetrics').textContent.includes('5 / 12s'));
  state = { ...state, buffered: { ...state.buffered, ready: true } };
  await publish();
  await page.waitForFunction(() => document.querySelector('#cpuActivityMetrics').textContent.includes('Look-ahead ready'));
  state = { ...state, cpuAudioBatch: { text: 'Background audio · 3–33 min · 45%' } };
  await publish();
  await page.waitForFunction(() => document.querySelector('#cpuActivityMetrics').textContent.includes('3–33 min · 45%'));
  state = { ...state, backend: 'browser', cpuAudioSource: 'live', cpuAudioReady: false, buffered: null,
    debug: 'YouTube download unavailable · listening live instead' };
  await publish();
  await page.waitForFunction(() => document.querySelector('#cpuActivitySource').textContent.includes('fallback'));
  assert.match(await page.$eval('#cpuActivityText', (el) => el.textContent), /listening live instead/);
  state = { ...state, capturing: false, status: 'error', error: 'Test CPU error' };
  await publish();
  await page.waitForFunction(() => document.querySelector('#problem').textContent === 'Test CPU error');
  assert.equal(await page.$eval('#cpuActivity', (el) => el.hidden), false, 'recent steps remain visible after an error');
  await page.select('#recognition', 'helper');
  await page.waitForFunction(() => document.querySelector('#cpuActivity').hidden);
  console.log('Production popup download percentage, source, recent steps, model progress, buffer readiness, fallback and GPU hiding passed.');
} finally { await browser.close(); }
