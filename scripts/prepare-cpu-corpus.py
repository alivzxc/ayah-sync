"""Fetch independent online recitations + reference timings for CPU evaluation.

All recordings must be <=10 minutes. No reference text is passed to ASR.
Generated files stay in the ignored server/cache/cpu-evaluation directory.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'server/cache/cpu-evaluation'
OUT.mkdir(parents=True, exist_ok=True)


def fetch(url, destination):
    if not destination.exists():
        subprocess.run(['curl', '--fail', '-L', '--retry', '2', '-A', 'Mozilla/5.0',
                        '-sS', url, '-o', str(destination)], check=True, timeout=120)


corpus = []
for reciter, chapter, name in [(7, 1, 'Alafasy'), (3, 78, 'Sudais'),
                               (6, 93, 'Husary'), (9, 67, 'Minshawi')]:
    key = f'{reciter}-{chapter}'
    metadata = OUT / f'{key}.json'
    fetch(f'https://api.quran.com/api/v4/chapter_recitations/{reciter}/{chapter}?segments=true', metadata)
    info = json.loads(metadata.read_text())['audio_file']
    audio = OUT / f'{key}.mp3'
    fetch(info['audio_url'], audio)
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                     'format=duration', '-of', 'csv=p=0', str(audio)], text=True).strip())
    if duration > 600:
        raise RuntimeError(f'{name}: recording exceeds ten minutes ({duration}s)')
    for rate in ([1, 1.2] if reciter == 7 else [1]):
        variant = f'{key}-{rate}'
        pcm = OUT / f'{variant}.f32'
        if not pcm.exists():
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(audio), '-af', f'atempo={rate}',
                            '-ar', '16000', '-ac', '1', '-f', 'f32le', str(pcm)], check=True, timeout=60)
        references = [{'ref': t['verse_key'], 'start': t['timestamp_from'] / 1000 / rate,
                       'end': t['timestamp_to'] / 1000 / rate} for t in info['timestamps']]
        corpus.append({'id': variant, 'reciter': name, 'rate': rate, 'duration': duration / rate,
                       'source': info['audio_url'], 'pcm': pcm.name, 'references': references,
                       'groundTruth': 'Quran.com published verse timings'})
        print(name, chapter, rate, round(duration / rate), 'seconds', flush=True)

# Independent online videos, not used for quantitative accuracy: existing helper
# alignments are machine predictions, NOT ground truth. Used for robustness logs.
for video in ['LsOilXMqkBw', '5I7thLd47C0']:
    info_path = ROOT / f'server/cache/Youtube_{video}.json'
    if not info_path.exists():
        continue
    info = json.loads(info_path.read_text())
    if not 0 < info.get('duration', 0) <= 600:
        continue
    pcm = OUT / f'video-{video}.f32'
    if not pcm.exists():
        source = next((p for p in (ROOT / 'server/cache').glob(f'Youtube_{video}.*')
                       if p.suffix in ('.webm', '.mp3', '.m4a')), None)
        if source is None:
            continue
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-ar', '16000',
                        '-ac', '1', '-f', 'f32le', str(pcm)], check=True, timeout=60)
    corpus.append({'id': f'video-{video}', 'reciter': info.get('title', video), 'rate': 1,
                   'duration': info['duration'], 'source': f'https://www.youtube.com/watch?v={video}',
                   'pcm': pcm.name, 'references': [], 'groundTruth': None})

(OUT / 'corpus.json').write_text(json.dumps(corpus, ensure_ascii=False, indent=2))
print('Saved', OUT / 'corpus.json')
