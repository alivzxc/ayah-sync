// Python matcher's normalization/offset voting, with contextual tie-breaking for refrains.
export function normalizeArabic(text) {
  return (text || '')
    // An internal small yeh is a letter (Ibrahim, nabiyyin), not a removable
    // pronoun-ending mark. Preserve it so shared phrases compare equally.
    .replace(/ۦ(?=[ء-ي])/g, 'ي')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '')
    .replace(/[^ء-ي\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w) => w[0] + w.slice(1).replace(/ا/g, '')).join(' ');
}

export class QuranMatcher {
  constructor(arabic, english, surahs, indopak = {}) {
    Object.assign(this, { arabic, english, surahs, indopak });
    this.meta = new Map(surahs.map((s) => [s.number, s]));
    this.tokens = [];
    this.refs = [];
    this.words = [];
    this.trigrams = new Map();
    this.orderedRefs = [];
    this.refStarts = new Map();
    for (const s of surahs) {
      for (let a = 1; a <= s.ayahs; a++) {
        const ref = `${s.number}:${a}`;
        this.refStarts.set(ref, this.tokens.length);
        if (arabic[ref]) this.orderedRefs.push(ref);
        (arabic[ref] || '').trim().split(/\s+/).forEach((word, wi) => {
          const normalized = normalizeArabic(word);
          if (!normalized) return;
          for (const token of normalized.split(' ')) {
            this.tokens.push(token);
            this.refs.push(ref);
            this.words.push(wi);
          }
        });
      }
    }
    for (let i = 0; i < this.tokens.length - 2; i++) {
      const key = this.tokens.slice(i, i + 3).join(' ');
      if (!this.trigrams.has(key)) this.trigrams.set(key, []);
      this.trigrams.get(key).push(i);
    }
  }

  ayah(ref) {
    if (!this.arabic[ref]) return null;
    const [surah, ayah] = ref.split(':').map(Number);
    return { ref, surah, ayah, arabic: this.arabic[ref], arabicIndopak: this.indopak[ref] || '',
      translation: this.english[ref] || '', surahMeta: this.meta.get(surah) };
  }

  result(pos, score) {
    pos = Math.max(0, Math.min(pos, this.refs.length - 1));
    const a = this.ayah(this.refs[pos]);
    if (!a) return null;
    // In salah, Al-Fatiha can be followed by any passage, not necessarily 2:1.
    const nextRef = a.ref === '1:7' ? null : a.ayah < this.meta.get(a.surah).ayahs ? `${a.surah}:${a.ayah + 1}`
      : a.surah < 114 ? `${a.surah + 1}:1` : null;
    return { ...a, score, pos, word: this.words[pos],
      wordCount: a.arabic.trim().split(/\s+/).length, next: this.ayah(nextRef || '') };
  }

  nearbyRefs(anchor) {
    const i = this.orderedRefs.indexOf(this.refs[anchor]);
    const refs = this.orderedRefs.slice(Math.max(0, i - 1), i + 3);
    return new Set(this.refs[anchor] === '1:7' ? refs.filter((ref) => ref.startsWith('1:')) : refs);
  }

  // Full short ayahs need context, not a weaker global n-gram threshold.
  shortMatch(text, refs) {
    const tokens = normalizeArabic(text).split(' ').filter(Boolean);
    if (!tokens.length || tokens.length > 2) return null;
    const matches = [...refs].filter((ref) => normalizeArabic(this.arabic[ref]) === tokens.join(' '));
    if (matches.length !== 1) return null;
    const ref = matches[0], start = this.refStarts.get(ref);
    const match = this.result(start + tokens.length - 1, 1);
    return { ...match, evidenceWords: tokens.length, refEvidenceWords: tokens.length,
      refWordCount: tokens.length, supported: [{ ...match,
        evidence: tokens.map((_, heard) => ({ heard, word: this.words[start + heard] })) }] };
  }

  match(text, anchor = null, { localOnly = false, nearbyRefs = null, evidenceOnly = false,
    currentRef = null, nextRef = null, allowEarlierEvidence = false } = {}) {
    const tokens = normalizeArabic(text).split(' ').filter(Boolean);
    const contextRef = currentRef || (anchor == null ? null : this.refs[anchor]);
    const expectedRef = nextRef || (contextRef ? this.result(this.refStarts.get(contextRef))?.next?.ref : null);
    const surahPrefix = contextRef ? `${contextRef.split(':')[0]}:` : null;
    const recovering = allowEarlierEvidence && localOnly && evidenceOnly && nearbyRefs != null;
    const priority = (pos) => {
      // Historical recovery needs a unique location within its allowed refs;
      // today's current ayah cannot disambiguate an earlier repeated refrain.
      if (!contextRef || recovering) return 0;
      const ref = this.refs[pos];
      // Keep current and next together: overlapping audio must not advance an
      // identical refrain early. Both outrank a shared phrase in another surah.
      if (ref === contextRef || ref === expectedRef) return 0;
      return ref?.startsWith(surahPrefix) ? 1 : 2;
    };
    const vote = (index, size, contextual = false) => {
      if (tokens.length < size) return null;
      const votes = new Map();
      const evidence = new Map();
      for (let i = 0; i <= tokens.length - size; i++) {
        for (const pos of index.get(tokens.slice(i, i + size).join(' ')) || []) {
          votes.set(pos - i, (votes.get(pos - i) || 0) + 1);
          const e = evidence.get(pos - i) || { last: 0, words: new Set() };
          e.last = Math.max(e.last, pos + size - 1);
          for (let k = 0; k < size; k++) e.words.add(i + k);
          evidence.set(pos - i, e);
        }
      }
      let best = null;
      for (const [offset, count] of votes) {
        const endpoint = offset + tokens.length - 1;
        const rank = priority(evidenceOnly ? Math.min(endpoint, evidence.get(offset).last) : endpoint);
        const behind = contextual && endpoint < anchor - 2;
        const distance = contextual ? Math.abs(endpoint - anchor) : 0;
        if (!best || count > best.count || (count === best.count && (rank < best.rank ||
            (rank === best.rank && contextual && (Number(behind) < Number(best.behind) ||
              (behind === best.behind && distance < best.distance)))))) {
          best = { offset, count, rank, behind, distance };
        }
      }
      if (!best) return null;
      const e = evidence.get(best.offset);
      // Do not advance into an unheard ayah because ASR appended/repeated words.
      const end = evidenceOnly ? Math.min(best.offset + tokens.length - 1, e.last) : best.offset + tokens.length - 1;
      const result = this.result(end, best.count / (tokens.length - size + 1));
      if (evidenceOnly) {
        const supported = (offset, e) => {
          const byRef = new Map();
          for (const heard of [...e.words].sort((a, b) => a - b)) {
            const pos = offset + heard;
            if (pos < 0 || pos >= this.refs.length) continue;
            const ref = this.refs[pos], entry = byRef.get(ref) || { pos, evidence: [] };
            entry.pos = pos;
            entry.evidence.push({ heard, word: this.words[pos] });
            byRef.set(ref, entry);
          }
          return [...byRef.values()].flatMap(({ pos, evidence }) => {
            const match = this.result(pos, result.score);
            const count = normalizeArabic(match.arabic).split(' ').filter(Boolean).length;
            return evidence.length >= Math.min(2, count) ? [{ ...match, evidence }] : [];
          });
        };
        result.evidenceWords = e.words.size;
        result.refEvidenceWords = [...e.words].filter((i) => this.refs[best.offset + i] === result.ref).length;
        result.refWordCount = normalizeArabic(result.arabic).split(' ').filter(Boolean).length;
        result.alternatives = [...votes].filter(([offset, count]) => count === best.count &&
          priority(Math.min(offset + tokens.length - 1, evidence.get(offset).last)) === best.rank).map(([offset]) => {
          const e = evidence.get(offset);
          const pos = Math.min(offset + tokens.length - 1, e.last);
          return { pos, ref: this.refs[pos], score: result.score, evidenceWords: e.words.size,
            refEvidenceWords: [...e.words].filter((i) => this.refs[offset + i] === this.refs[pos]).length,
            refWordCount: normalizeArabic(this.arabic[this.refs[pos]]).split(' ').filter(Boolean).length,
            supported: supported(offset, e) };
        });
        result.supported = supported(best.offset, e);
        result.ambiguous = result.alternatives.some((a) => a.ref !== result.ref);
      }
      return result;
    };
    const global = localOnly ? null : vote(this.trigrams, 3);
    if (anchor == null) return global?.score >= 0.5 ? global : null;
    const local = new Map();
    for (let i = Math.max(0, anchor - 40); i < Math.min(this.tokens.length, anchor + 300) - 1; i++) {
      if (nearbyRefs && (!nearbyRefs.has(this.refs[i]) || !nearbyRefs.has(this.refs[i + 1]))) continue;
      const key = this.tokens.slice(i, i + 2).join(' ');
      if (!local.has(key)) local.set(key, []);
      local.get(key).push(i);
    }
    const nearby = vote(local, 2, true);
    // Identical verses/refrains can be perfect global matches in several places.
    // Prefer an equally strong nearby continuation; seeking clears the anchor.
    if (nearby && (recovering || nearby.pos >= anchor - 2) && nearby.score >= Math.max(0.2, (global?.score || 0) - 0.05)) return nearby;
    if (global?.score >= 0.6) return global;
    if (nearby?.score >= 0.2 && (recovering || nearby.pos >= anchor - 20)) return nearby;
    return global?.score >= 0.45 ? global : null;
  }

}
