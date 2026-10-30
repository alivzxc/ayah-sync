"""Bounded PCM windows for browser CPU look-ahead; no speech model is loaded."""
import asyncio
import base64
import json
import math
import subprocess
import threading
import hashlib
import tempfile
import time
from contextlib import suppress
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

import align

SR = 16000
MAX_WINDOW = 24
INITIAL_SECONDS = 180
BATCH_SECONDS = 1800
MAX_DURATION = 10 * 60 * 60


class DownloadCancelled(Exception):
    pass


@lru_cache(maxsize=1)
def youtube_range_options():
    # YouTube throttles open-ended media requests. Small bounded requests also
    # prevent FFmpeg probing/seeking from reading most of a long recording.
    # These options aren't available in older FFmpeg builds.
    help_text = subprocess.run(["ffmpeg", "-hide_banner", "-h", "protocol=http"],
                               capture_output=True, check=True, timeout=10).stdout
    if b"-request_size " not in help_text or b"-initial_request_size " not in help_text:
        return []
    return ["-request_size", "1048576", "-initial_request_size", "32768",
            "-multiple_requests", "1"]


def run_media(command, cancelled, timeout):
    """Keep range downloads interruptible, including FFmpeg's network reads."""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            deadline = time.monotonic() + timeout
            while True:
                if cancelled.is_set():
                    raise DownloadCancelled("Audio download cancelled")
                if time.monotonic() >= deadline:
                    raise TimeoutError("Audio download timed out")
                try:
                    out, err = process.communicate(timeout=0.25)
                    if process.returncode:
                        raise RuntimeError(err.decode(errors="replace")[-1000:])
                    return out
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


def batch_bounds(index, duration, initial_start=0):
    if index < 0:
        end = initial_start + (index + 1) * BATCH_SECONDS
        return max(0, end - BATCH_SECONDS), end
    start = initial_start if index == 0 else initial_start + INITIAL_SECONDS + (index - 1) * BATCH_SECONDS
    return start, min(duration, start + (INITIAL_SECONDS if index == 0 else BATCH_SECONDS))


def batch_index(position, initial_start=0):
    if position < initial_start:
        return -math.ceil((initial_start - position) / BATCH_SECONDS)
    offset = position - initial_start
    return 0 if offset < INITIAL_SECONDS else 1 + int((offset - INITIAL_SECONDS) // BATCH_SECONDS)


def fetch_batch(source, index, report=None):
    # Separate locks let a seek fetch its batch without waiting for an unrelated
    # background download. Readers never see a partially written cache file.
    with source["locks_guard"]:
        lock = source["locks"].setdefault(index, threading.Lock())
    with lock:
        if source["cancelled"].is_set():
            raise DownloadCancelled("Audio download cancelled")
        start, end = batch_bounds(index, source["duration"], source["initial_start"])
        path = source["cache"] / f"{int(start)}-{end:.3f}.flac"
        if not path.exists():
            if report:
                report(0)
            with tempfile.TemporaryDirectory(dir=source["cache"]) as temp:
                output = Path(temp) / "audio.flac"
                run_media(["ffmpeg", "-nostdin", "-v", "error", "-threads", "1",
                           *source["input_options"], "-ss", str(start), "-i", source["url"],
                           "-t", str(end - start), "-vn", "-ar", str(SR), "-ac", "1",
                           "-c:a", "flac", str(output)], source["cancelled"],
                          180 if index == 0 else 7200)
                output.replace(path)
        if report:
            report(1)
        return path


def prepare(url, media=None, report=None, cancelled=None, position=0):
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("Open an HTTP(S) video page first.")
    position = float(position)
    if not math.isfinite(position) or position < 0:
        raise ValueError("Invalid playback position.")
    import yt_dlp
    cancelled = cancelled if cancelled is not None else threading.Event()
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True,
                              "format": "bestaudio/best", "socket_timeout": 15,
                              "retries": 2, "extractor_retries": 2}) as ydl:
            info = ydl.extract_info(url, download=False)
        audio_url = info["url"]
    except Exception:
        if cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        if not media or urlsplit(media).scheme not in ("http", "https"):
            raise
        info = {"title": "", "http_headers": {"Referer": url}}
        audio_url = media
    if info.get("is_live"):
        raise ValueError("Use CPU live listening for streams.")
    headers = "".join(f"{k}: {v}\r\n" for k, v in info.get("http_headers", {}).items()
                      if not any(c in str(k) + str(v) for c in "\r\n"))
    options = ["-rw_timeout", "30000000"]
    if (urlsplit(audio_url).hostname or "").endswith(".googlevideo.com"):
        options += youtube_range_options()
    if headers:
        options += ["-headers", headers]
    duration = info.get("duration")
    if not duration:
        duration = run_media(
            ["ffprobe", "-v", "error", *options, "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", audio_url], cancelled, 30)
    duration = float(duration)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("This video has no finite audio duration. Use CPU live listening for streams.")
    if duration > MAX_DURATION:
        raise ValueError("CPU audio downloads support videos up to 10 hours.")
    # Never share partial CPU downloads with the GPU's full-file cache.
    cache = align.CACHE_DIR / "cpu-batches" / hashlib.sha256(url.encode()).hexdigest()[:24]
    cache.mkdir(parents=True, exist_ok=True)
    # Match the recognizer's ten-second seek pre-roll without fetching the
    # beginning of the video. Earlier audio is downloaded only if requested.
    initial_start = max(0, math.floor(min(position, duration)) - 10)
    source = {"url": audio_url, "input_options": options, "cache": cache, "initial_start": initial_start,
              "duration": duration, "title": info.get("title", ""), "cancelled": cancelled,
              "locks": {}, "locks_guard": threading.Lock()}
    fetch_batch(source, 0, report)
    return source


def read_window(source, start, seconds):
    start, seconds = float(start), float(seconds)
    if not math.isfinite(start) or not math.isfinite(seconds) or start < 0 or not 0 < seconds <= MAX_WINDOW:
        raise ValueError("Invalid audio window (maximum 24 seconds).")
    parts = []
    position, end = start, min(start + seconds, source["duration"])
    while position < end:
        index = batch_index(position, source["initial_start"])
        batch_start, batch_end = batch_bounds(index, source["duration"], source["initial_start"])
        path = fetch_batch(source, index)
        stop = min(end, batch_end)
        parts.append(run_media(
            ["ffmpeg", "-v", "error", "-threads", "1", "-ss", str(position - batch_start),
             "-i", str(path), "-t", str(stop - position), "-ar", str(SR), "-ac", "1",
             "-f", "f32le", "-"], source["cancelled"], 30))
        position = stop
    raw = b"".join(parts)
    if len(raw) > math.ceil(seconds * SR) * 4 + 4096:
        raise ValueError("Audio window exceeded its limit.")
    return base64.b64encode(raw).decode("ascii")


async def prepare_message(ws, data):
    progress = {"pct": 0.0, "stage": "resolving"}
    started = time.monotonic()
    cancelled = threading.Event()
    def report(value):
        if cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        progress["pct"] = float(value)
        progress["stage"] = "downloading"
    async def watch_close():
        await ws.wait_closed()
        cancelled.set()
    async def heartbeat():
        while True:
            await ws.send(json.dumps({"type": "cpu_audio_progress", **progress,
                                      "elapsedSeconds": int(time.monotonic() - started)}))
            await asyncio.sleep(1)
    task = asyncio.create_task(heartbeat())
    closed = asyncio.create_task(watch_close())
    source = None
    try:
        source = await asyncio.to_thread(prepare, data.get("url", ""), data.get("media"), report, cancelled,
                                         data.get("position", 0))
        if cancelled.is_set():
            raise DownloadCancelled("Audio download cancelled")
        await ws.send(json.dumps({"type": "cpu_audio_ready", "duration": source["duration"],
                                   "title": source["title"], "sampleRate": SR,
                                   "initialStart": source["initial_start"]}))
        async def prefetch():
            try:
                index = 1
                while batch_bounds(index, source["duration"], source["initial_start"])[0] < source["duration"]:
                    await asyncio.to_thread(fetch_batch, source, index)
                    index += 1
            except Exception:
                # A failed prefetch is retried if playback requests that batch.
                pass
        source["prefetch_task"] = asyncio.create_task(prefetch())
        source["close_task"] = closed
        return source
    finally:
        task.cancel()
        if source is None or "close_task" not in source:
            cancelled.set()
            closed.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task
        if source is None or "close_task" not in source:
            with suppress(asyncio.CancelledError, Exception):
                await closed


async def window_message(ws, source, data):
    if source is None:
        raise ValueError("Prepare the video audio first.")
    pcm = await asyncio.to_thread(read_window, source, data.get("start", 0), data.get("seconds", 16))
    await ws.send(json.dumps({"type": "cpu_audio_window", "id": data.get("id"),
                              "start": data.get("start", 0), "pcm": pcm, "sampleRate": SR}))
