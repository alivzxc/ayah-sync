"""
Ayah Sync — local helper.

Two jobs, one WebSocket (ws://127.0.0.1:8790):

  SYNC A VIDEO   {"type": "align", "url": ...}
      Downloads the video's audio once, recognises which ayahs are recited and
      force-aligns every word to the audio. Replies with a word-level timeline
      the extension follows using video.currentTime — exact, and it survives
      pausing and seeking. Results are cached per video.

  LISTEN LIVE    binary 16 kHz mono Float32 PCM frames
      For live streams, where there is no whole file to align: keeps a rolling
      window, transcribes it every few seconds and reports the current ayah.

Run:  python server.py         (see run.bat / run.sh)
"""
import asyncio
import json
import time

import numpy as np
import websockets

import engine
import align
import audio_source
import helper_health

SR = 16000
WINDOW_SEC = 6.0          # rolling window analysed each pass (live mode)
INTERVAL_SEC = 2.5        # how often we transcribe (live mode)
MIN_AUDIO_SEC = 1.5
MAX_NEW_TOKENS = 100
SILENCE_PEAK = 0.005
HOST = "127.0.0.1"
PORT = 8790

engine.load()
matcher = engine.matcher


def transcribe(audio: np.ndarray) -> str:
    gk = {"num_beams": 1, "max_new_tokens": MAX_NEW_TOKENS}
    if engine.MULTILINGUAL:
        gk["language"] = "arabic"
        gk["task"] = "transcribe"
    with engine.gpu_lock:
        out = engine.asr(audio, generate_kwargs=gk)
    return (out.get("text") or "").strip()


def run_align(url: str, force: bool, report, media=None):
    with engine.gpu_lock:
        return align.align_url(engine.asr, matcher, engine.ctc(), url,
                               engine.MULTILINGUAL, progress=report, force=force, media=media)


async def handle_align(ws, data):
    """Sync one video; streams progress so the extension can show it."""
    loop = asyncio.get_running_loop()
    url = data.get("url") or ""
    state = {"stage": "queued", "pct": 0.0}

    def report(stage, frac=None):
        state["stage"], state["pct"] = stage, float(frac or 0.0)

    async def heartbeat():
        while True:
            await ws.send(json.dumps({"type": "align_progress", **state}))
            await asyncio.sleep(1.0)

    hb = asyncio.create_task(heartbeat())
    t0 = time.time()
    try:
        print(f"Sync requested: {url}")
        tl = await loop.run_in_executor(None, run_align, url, bool(data.get("force")), report, data.get("media"))
        hb.cancel()
        n = len(tl["ayahs"])
        print(f"  synced in {time.time()-t0:.1f}s — {n} ayahs, passages "
              f"{[(p['from'], p['to']) for p in tl['passages']]}")
        if n == 0:
            await ws.send(json.dumps({"type": "align_error",
                                      "error": "No Quran recitation was recognised in this video."}))
        else:
            await ws.send(json.dumps({"type": "align_result", "timeline": tl}, ensure_ascii=False))
    except websockets.ConnectionClosed:
        hb.cancel()
    except Exception as e:
        hb.cancel()
        msg = str(e).splitlines()[-1][:300] if str(e) else type(e).__name__
        print(f"  sync failed: {msg}")
        try:
            await ws.send(json.dumps({"type": "align_error", "error": msg}))
        except websockets.ConnectionClosed:
            pass


async def handle(ws):
    print("Client connected")
    buf = np.zeros(0, dtype=np.float32)
    win = int(WINDOW_SEC * SR)
    stop = False
    cpu_source = None
    await ws.send(json.dumps({"type": "ready", "model": engine.MODEL_ID, "device": engine.device,
                              "capabilities": {"cpu_audio": True, "align": True, "live": True}}))

    async def live_loop():
        nonlocal buf
        anchor = None  # last accepted token position (forward-tracking)
        while not stop:
            await asyncio.sleep(INTERVAL_SEC)
            try:
                if len(buf) < MIN_AUDIO_SEC * SR:
                    continue
                audio = buf[-win:].astype(np.float32, copy=True)
                peak = float(np.max(np.abs(audio)))
                if peak < SILENCE_PEAK:
                    continue
                audio = audio / peak  # peak-normalize (livestreams often clip)
                t0 = time.time()
                text = await asyncio.get_running_loop().run_in_executor(None, transcribe, audio)
                ms = int((time.time() - t0) * 1000)
                if not text:
                    continue

                # Forward-tracking: a strong global match anchors or re-seeks; a
                # weak-but-local match keeps advancing through noisy audio.
                g = matcher.match_global(text)
                l = matcher.match_local(text, anchor) if anchor is not None else None
                chosen = None
                if anchor is None:
                    if g and g["score"] >= 0.5:
                        chosen = g
                else:
                    if g and g["score"] >= 0.6:
                        chosen = g            # confident: allow a jump / re-seek
                    elif l and l["score"] >= 0.20 and l["pos"] >= anchor - 20:
                        chosen = l            # local forward progress
                    elif g and g["score"] >= 0.45:
                        chosen = g

                if chosen:
                    anchor = chosen["pos"]
                    payload = {k: v for k, v in chosen.items() if k != "pos"}
                    print(f"  {ms}ms  {chosen['ref']} w{chosen['word']}/{chosen['wordCount']} "
                          f"score {chosen['score']:.2f}  <{text[:40]}>")
                    await ws.send(json.dumps({"type": "result", "match": payload}, ensure_ascii=False))
                else:
                    print(f"  {ms}ms  no match  <{text[:40]}>")
            except websockets.ConnectionClosed:
                break
            except Exception as e:
                # Never let one bad iteration kill the loop.
                print(f"  [loop error] {type(e).__name__}: {e}")

    task = asyncio.create_task(live_loop())
    jobs = []
    try:
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                chunk = np.frombuffer(msg, dtype=np.float32)
                if chunk.size:
                    buf = np.concatenate([buf, chunk])
                    if len(buf) > win:
                        buf = buf[-win:]  # keep only the rolling window
            else:
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                if data.get("type") == "reset":
                    buf = np.zeros(0, dtype=np.float32)
                elif data.get("type") == "align":
                    jobs.append(asyncio.create_task(handle_align(ws, data)))
                elif data.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                elif data.get("type") in ("cpu_audio_prepare", "cpu_audio_window"):
                    try:
                        if data["type"] == "cpu_audio_prepare":
                            cpu_source = await audio_source.prepare_message(ws, data)
                        else:
                            await audio_source.window_message(ws, cpu_source, data)
                    except Exception as error:
                        await ws.send(json.dumps({"type": "cpu_audio_error", "error": str(error)[-300:]}))
    except websockets.ConnectionClosed:
        pass
    finally:
        stop = True
        task.cancel()
        print("Client disconnected")


async def main():
    print(f"Listening on ws://{HOST}:{PORT}")
    async with websockets.serve(handle, HOST, PORT, max_size=None, process_request=helper_health.process_request):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
