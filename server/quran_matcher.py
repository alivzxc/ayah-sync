"""
Quran fuzzy matcher (Python port of src/cpu/match.js).

Given a noisy Arabic transcript, finds the ayah most likely being recited *now*
via trigram-alignment voting, and the current word index within that ayah for
karaoke highlighting. Diacritic-insensitive so it tolerates ASR errors.
"""
import json
import re
from pathlib import Path

# --- Arabic normalization (port of normalize.js) ----------------------------
# Combining marks: Quranic annotation signs, harakat, superscript alef, tatweel.
_DIACRITICS = re.compile(
    "[ؐ-ًؚ-ٰٟۖ-ۭـ]"
)
_NON_LETTER = re.compile(r"[^ء-ي\s]")


def normalize_arabic(text: str) -> str:
    if not text:
        return ""
    s = _DIACRITICS.sub("", text)
    s = re.sub("[آأإٱ]", "ا", s)  # alef variants -> bare alef
    s = s.replace("ى", "ي")  # alef maksura -> yaa
    s = s.replace("ة", "ه")  # teh marbuta -> haa
    s = s.replace("ؤ", "و").replace("ئ", "ي")  # hamza carriers
    s = s.replace("ء", "")  # standalone hamza
    s = _NON_LETTER.sub(" ", s)
    # The Uthmani script writes many long "a" sounds as a mark, not a letter
    # (بَٰرَكْنَا, ٱلْعَٰلَمِينَ), while speech recognisers spell them out
    # (باركنا, العالمين). Dropping every non-initial alef makes both spellings
    # land on the same key.
    return " ".join(w[0] + w[1:].replace("ا", "") for w in s.split())


def tokenize(text: str):
    n = normalize_arabic(text)
    return n.split(" ") if n else []


class QuranMatcher:
    def __init__(self, data_dir: Path, min_score: float = 0.34):
        self.min_score = min_score
        self.arabic = json.loads((data_dir / "quran-uthmani.json").read_text("utf-8"))
        self.english = json.loads((data_dir / "quran-en.json").read_text("utf-8"))
        self.surahs = json.loads((data_dir / "surahs.json").read_text("utf-8"))
        try:
            self.indopak = json.loads((data_dir / "quran-indopak.json").read_text("utf-8"))
        except FileNotFoundError:
            self.indopak = {}
        self._surah_by_num = {s["number"]: s for s in self.surahs}

        self.tokens = []
        self.pos_to_ref = []
        self.pos_to_word = []
        self.trigrams = {}  # "a b c" -> [positions]

        for s in self.surahs:
            for a in range(1, s["ayahs"] + 1):
                ref = f'{s["number"]}:{a}'
                text = self.arabic.get(ref)
                if not text:
                    continue
                for wi, w in enumerate(re.split(r"\s+", text.strip())):
                    if not w:
                        continue
                    norm = normalize_arabic(w)
                    if not norm:
                        continue
                    for t in norm.split(" "):
                        self.tokens.append(t)
                        self.pos_to_ref.append(ref)
                        self.pos_to_word.append(wi)

        for i in range(len(self.tokens) - 2):
            key = f"{self.tokens[i]} {self.tokens[i+1]} {self.tokens[i+2]}"
            self.trigrams.setdefault(key, []).append(i)

    def _ayah(self, ref):
        if ref not in self.arabic:
            return None
        surah, ayah = (int(x) for x in ref.split(":"))
        return {
            "ref": ref,
            "surah": surah,
            "ayah": ayah,
            "arabic": self.arabic[ref],
            "arabicIndopak": self.indopak.get(ref, ""),
            "translation": self.english.get(ref, ""),
            "surahMeta": self._surah_by_num.get(surah),
        }

    def _next_ref(self, surah, ayah):
        # In salah, any passage may follow Al-Fatiha; do not preview Al-Baqarah.
        if surah == 1 and ayah == 7:
            return None
        meta = self._surah_by_num.get(surah)
        if meta and ayah < meta["ayahs"]:
            return f"{surah}:{ayah + 1}"
        if surah < 114:
            return f"{surah + 1}:1"
        return None

    def _result_from_pos(self, last_pos: int, score: float):
        last_pos = max(0, min(last_pos, len(self.pos_to_ref) - 1))
        ref = self.pos_to_ref[last_pos]
        surah, ayah = (int(x) for x in ref.split(":"))
        word = self.pos_to_word[last_pos]
        word_count = len([w for w in re.split(r"\s+", self.arabic.get(ref, "").strip()) if w])
        next_ref = self._next_ref(surah, ayah)
        return {
            "ref": ref,
            "surah": surah,
            "ayah": ayah,
            "score": score,
            "word": word,
            "wordCount": word_count,
            "pos": last_pos,
            "arabic": self.arabic.get(ref, ""),
            "arabicIndopak": self.indopak.get(ref, ""),
            "translation": self.english.get(ref, ""),
            "surahMeta": self._surah_by_num.get(surah),
            "next": self._ayah(next_ref) if next_ref else None,
        }

    def match_global(self, transcript: str):
        """High-precision trigram match over the whole Quran."""
        toks = tokenize(transcript)
        if len(toks) < 3:
            return None
        votes = {}
        possible = 0
        for i in range(len(toks) - 2):
            possible += 1
            for p in self.trigrams.get(f"{toks[i]} {toks[i+1]} {toks[i+2]}", ()):
                votes[p - i] = votes.get(p - i, 0) + 1
        if not votes:
            return None
        off, v = max(votes.items(), key=lambda kv: kv[1])
        return self._result_from_pos(off + len(toks) - 1, v / possible)

    def match_local(self, transcript: str, anchor_pos: int, back: int = 40, fwd: int = 300):
        """Lenient BIGRAM match within a forward window around anchor_pos. Noisy
        ASR rarely yields exact trigrams, but a couple of correct adjacent words
        near where we already are is enough to keep tracking the recitation."""
        toks = tokenize(transcript)
        if len(toks) < 2 or anchor_pos is None:
            return None
        lo = max(0, anchor_pos - back)
        hi = min(len(self.tokens), anchor_pos + fwd)
        local = {}
        for j in range(lo, hi - 1):
            local.setdefault(f"{self.tokens[j]} {self.tokens[j+1]}", []).append(j)
        votes = {}
        possible = 0
        for i in range(len(toks) - 1):
            possible += 1
            for p in local.get(f"{toks[i]} {toks[i+1]}", ()):
                votes[p - i] = votes.get(p - i, 0) + 1
        if not votes:
            return None
        off, v = max(votes.items(), key=lambda kv: kv[1])
        return self._result_from_pos(off + len(toks) - 1, v / max(1, possible))

    # Backwards-compatible single-shot match (global only).
    def match(self, transcript: str):
        return self.match_global(transcript)
