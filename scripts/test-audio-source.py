"""No model downloads: test the lightweight helper's bounded audio interface."""
import base64
import math
import struct
import sys
import tempfile
import unittest
import wave
import threading
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import audio_source


class AudioSourceTest(unittest.TestCase):
    def test_window_is_bounded_and_no_speech_model_loaded(self):
        self.assertNotIn("engine", sys.modules)
        self.assertNotIn("torch", sys.modules)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"".join(struct.pack("<h", int(1000 * math.sin(i * 0.1))) for i in range(32000)))
            source = {"duration": 2, "initial_start": 0, "cancelled": threading.Event()}
            with patch.object(audio_source, "fetch_batch", return_value=path):
                raw = base64.b64decode(audio_source.read_window(source, 0.5, 0.5))
            self.assertEqual(len(raw), 8000 * 4)
            for start, duration in [(-1, 1), (0, 25), (float("nan"), 1), (0, float("inf"))]:
                with self.assertRaises(ValueError):
                    audio_source.read_window(source, start, duration)

    def test_ten_hour_batch_plan_and_seek_positions(self):
        self.assertEqual(audio_source.INITIAL_SECONDS, 180)
        self.assertEqual(audio_source.BATCH_SECONDS, 1800)
        self.assertEqual(audio_source.MAX_DURATION, 36000)
        initial = 3590
        for index in range(-2, 19):
            start, end = audio_source.batch_bounds(index, 36000, initial)
            if start >= end:
                continue
            self.assertLessEqual(end - start, 180 if index == 0 else 1800)
            self.assertEqual(audio_source.batch_index(start, initial), index)
            self.assertEqual(audio_source.batch_index(end - 0.001, initial), index)
        self.assertEqual(audio_source.batch_bounds(0, 36000, initial), (3590, 3770))
        self.assertEqual(audio_source.batch_bounds(1, 36000, initial), (3770, 5570))


if __name__ == "__main__":
    unittest.main()
