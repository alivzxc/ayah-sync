"""Download-only CPU helper: python audio_server.py (no torch/GPU/ASR loading)."""
import asyncio
import json
import websockets
import audio_source
import helper_health


async def handle(ws):
    source = None
    await ws.send(json.dumps({"type": "ready", "model": "Audio download only", "device": "cpu",
                              "capabilities": {"cpu_audio": True, "align": False, "live": False}}))
    async for message in ws:
        try:
            if not isinstance(message, str):
                continue
            data = json.loads(message)
            if data.get("type") == "cpu_audio_prepare":
                source = await audio_source.prepare_message(ws, data)
            elif data.get("type") == "cpu_audio_window":
                await audio_source.window_message(ws, source, data)
            elif data.get("type") == "align":
                await ws.send(json.dumps({"type": "align_error", "error":
                    "The audio-only helper supports Browser CPU look-ahead. Start server.py for GPU alignment."}))
        except websockets.ConnectionClosed:
            break
        except Exception as error:
            await ws.send(json.dumps({"type": "cpu_audio_error", "error": str(error)[-300:]}))


async def main():
    print("CPU audio-only helper listening on ws://127.0.0.1:8790 (no speech models)")
    async with websockets.serve(handle, "127.0.0.1", 8790, max_size=16384,
                                process_request=helper_health.process_request):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
