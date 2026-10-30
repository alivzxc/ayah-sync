"""Download the quantized browser model; end users need only the built extension."""
import json
from pathlib import Path
import shutil
from shutil import copyfileobj
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
MODEL = "Abdou/quran-asr-small"
OUT = ROOT / "public/models/quran-asr-small"
OUT.mkdir(parents=True, exist_ok=True)

for name in ("model.int8.onnx", "tokens.txt"):
    destination = OUT / name
    temporary = destination.with_suffix(destination.suffix + ".part")
    url = f"https://huggingface.co/{MODEL}/resolve/main/{name}?download=true"
    with urlopen(url) as response, temporary.open("wb") as output:
        copyfileobj(response, output)
    temporary.replace(destination)
    print(f"Downloaded {destination}", flush=True)

(OUT / "source.json").write_text(json.dumps({"model": MODEL, "license": "mit",
                                            "runtime": "sherpa-onnx Zipformer CTC via ONNX Runtime Web"}, indent=2))

# Remove prior generated model folders only when their source metadata matches.
for legacy, old_model in (
    (ROOT / "public/models/quran-asr-tiny", "Abdou/quran-asr-tiny"),
    (ROOT / "public/models/quran-tiny", "tarteel-ai/whisper-tiny-ar-quran"),
):
    legacy_source = legacy / "source.json"
    if legacy_source.exists() and json.loads(legacy_source.read_text("utf-8")).get("model") == old_model:
        shutil.rmtree(legacy)

print(f"Browser model ready: {OUT}", flush=True)
