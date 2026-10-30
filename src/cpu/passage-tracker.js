// CPU browser tracker only (not the original Python GPU matcher). A passage
// must be confirmed before UI updates; pauses never advance a verse.
import { normalizeArabic } from './match.js';

export class PassageTracker {
  constructor(matcher) {
    this.matcher = matcher;
    this.reset();
  }

  reset(keepContext = false) {
    if (!keepContext) {
      this.anchor = null;
      this.current = null;
      this.locked = false;
      this.context = null;
    }
    this.pending = null;
    this.confirmations = 0;
    this.misses = 0;
    this.history = [];
    this.timingMatches = [];
    this.newPassage = false;
    this.lastWordStart = null;
  }

  state() {
    return { locked: this.locked, confirmations: this.confirmations,
      phase: this.locked ? 'tracking' : this.pending ? 'confirming' : 'identifying',
      ambiguousRefs: this.pending?.ambiguous
        ? [...new Set((this.pending.alternatives || []).filter((m) => m.score >= 0.6 && m.evidenceWords >= 3 &&
          m.refEvidenceWords >= Math.min(2, m.refWordCount)).map((m) => m.ref))] : [],
      ref: this.current?.ref || null, nextRef: this.current?.next?.ref || null,
      nearEnd: !!this.current && this.current.word >= this.current.wordCount - 2 };
  }

  accept(candidate, observation, newPassage = false) {
    const wasLocked = this.locked && !newPassage;
    this.newPassage ||= !wasLocked;
    if (newPassage) this.lastWordStart = null;
    const previousPos = this.current?.pos ?? -1;
    const { alternatives, supported, ...match } = candidate;
    if (wasLocked && candidate.ref === this.current?.next?.ref) this.collectPrefix(candidate, observation);
    if (!wasLocked) {
      // Resolve short startup windows only AFTER the passage is confirmed.
      // Stay inside this surah and a bounded preceding neighborhood; do not
      // globally identify a one-word ayah or infer missing verses by sequence.
      const refs = new Set(this.matcher.orderedRefs.filter((ref) => {
        const pos = this.matcher.refStarts.get(ref);
        return ref.startsWith(`${match.surah}:`) && pos <= match.pos && pos >= match.pos - 40;
      }));
      for (const prior of this.history.slice(0, -1)) {
        const recovered = this.matcher.shortMatch(prior.text, refs) || this.matcher.match(prior.text, match.pos,
          { localOnly: true, nearbyRefs: refs, evidenceOnly: true, allowEarlierEvidence: true });
        if (recovered && !recovered.ambiguous && recovered.score >= 0.6) {
          this.collectTimings(recovered, prior, -1, match.pos);
        }
      }
    }
    this.collectTimings(candidate, observation, wasLocked ? previousPos : -1, candidate.pos);
    if (observation.data) {
      const heard = observation.data.words.flatMap((w) => normalizeArabic(w.text).split(' ').filter(Boolean).map(() => w));
      for (const e of candidate.supported?.find((m) => m.ref === candidate.ref)?.evidence || []) {
        if (heard[e.heard]) this.lastWordStart = Math.max(this.lastWordStart ?? 0, observation.data.start + heard[e.heard].start);
      }
    }
    this.anchor = candidate.pos;
    this.current = match;
    this.context = match;
    this.locked = true;
    this.misses = 0;
    this.pending = null;
    return match;
  }

  collectTimings(candidate, observation, lower, upper) {
    for (const { evidence, ...match } of candidate.supported || []) {
      if ((match.ref === this.current?.ref || match.pos >= lower) && match.pos <= upper) {
        this.timingMatches.push({ match, evidence, observation: observation.data });
      }
    }
  }

  collectPrefix(candidate, observation) {
    // Long opening words can fill an entire rolling window. They are not enough
    // to advance the tracker, but their timing is useful AFTER later words have
    // independently confirmed this next ayah. Recover exact evidence only.
    const canon = candidate.arabic.trim().split(/\s+/).map(normalizeArabic);
    const first = canon.findIndex(Boolean), prefix = canon[first];
    if (!observation.data || !prefix || prefix.includes(' ') || this.lastWordStart === null ||
        normalizeArabic(this.current.arabic).split(' ').includes(prefix)) return;
    const floor = Math.max(this.lastWordStart + 0.04, observation.data.start - 8);
    const { alternatives, supported, ...match } = candidate;
    for (const prior of this.history.slice(0, -1)) {
      if (!prior.data) continue;
      let heard = 0;
      for (const word of prior.data.words) {
        const text = normalizeArabic(word.text), count = text.split(' ').filter(Boolean).length;
        if (text === prefix && prior.data.start + word.start > floor) {
          this.timingMatches.push({ match, evidence: [{ heard, word: first }], observation: prior.data, recoveredPrefix: true });
        }
        heard += count;
      }
    }
  }

  update(text, observationWeight = 1, data = null) {
    this.timingMatches = [];
    this.newPassage = false;
    const observation = { text, data };
    this.history.push(observation);
    // Keep the first phrase available while a shared-location ambiguity is
    // resolved by later audio. Only compact token timings grow, not PCM/scores.
    const historyLimit = !this.locked && this.pending?.ambiguous ? 28 : 12;
    if (this.history.length > historyLimit) this.history.splice(0, this.history.length - historyLimit);
    // Rolling CTC windows often contain silence or an unfinished word at an
    // ayah boundary. That is no evidence of a different passage. In particular,
    // do not erase the basmala context while waiting for the next phrase.
    const words = (text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      if (this.locked && this.current?.next && this.current.word >= this.current.wordCount - 2) {
        const next = this.matcher.shortMatch(text, new Set([this.current.next.ref]));
        if (next) return this.accept(next, observation);
      }
      return null;
    }
    // Keep Al-Fatiha on screen while confirming the next passage globally.
    // Do not wait for six local misses or bias the search toward Al-Baqarah.
    const afterFatiha = this.locked && this.current?.ref === '1:7';
    if (this.locked && !afterFatiha) {
      const candidate = this.matcher.match(text, this.anchor, {
        localOnly: true, nearbyRefs: this.matcher.nearbyRefs(this.anchor), evidenceOnly: true,
        currentRef: this.current.ref, nextRef: this.current.next?.ref,
      });
      if (candidate && candidate.score >= 0.35 && candidate.evidenceWords >= 2) {
        // The overlapping window can still contain the previous verse. Never
        // move the card backwards on that stale audio; seeking resets context.
        if (candidate.ref !== this.current?.ref && candidate.pos < this.anchor) return null;
        if (candidate.ref !== this.current?.ref &&
          candidate.refEvidenceWords < Math.min(2, candidate.refWordCount)) {
          // A strong previous ayah plus one new token is not enough evidence
          // to switch. Count support in the proposed NEW ayah, not the window.
          return null;
        }
        return this.accept(candidate, observation);
      }
      // A single breath/noisy window must not send us to a different surah.
      // Half-second hops are highly correlated, not independent failures.
      // Short partial phrases must not force global re-identification either.
      if (words.length < 3 || (this.misses += observationWeight) < 6) return null;
      // A noisy window doesn't erase which surah we were following. An explicit
      // worker reset/seek still clears this hint via reset() above.
      const context = this.context;
      this.reset();
      this.context = context;
    }
    // Al-Fatiha can be followed by any passage; its basmala alone must remain
    // ambiguous rather than biasing every prayer transition back to Al-Fatiha.
    const context = afterFatiha ? null : this.context;
    let candidate = this.matcher.match(text, null, { evidenceOnly: true,
      currentRef: context?.ref, nextRef: context?.next?.ref });
    const restartingFatiha = candidate?.ref === '1:2' &&
      (this.pending?.alternatives || (this.pending ? [this.pending] : [])).some((c) => c.ref === '1:1');
    if (afterFatiha && candidate?.surah === 1 && candidate.ayah !== 1 && !restartingFatiha) {
      // Old Al-Fatiha audio in the rolling window cannot start a new passage.
      // A newly heard basmala followed by al-hamd can confirm a real restart.
      const local = this.matcher.match(text, this.anchor, {
        localOnly: true, nearbyRefs: new Set(['1:7']), evidenceOnly: true,
      });
      return local?.ref === '1:7' && local.score >= 0.35 && local.evidenceWords >= 2
        ? this.accept(local, observation) : null;
    }
    if (!candidate || candidate.score < 0.6 || candidate.evidenceWords < 3) {
      if (words.length >= 3 && (this.misses += observationWeight) >= 6) {
        this.pending = null;
        this.confirmations = 0;
      }
      return null;
    }
    this.misses = 0;
    const prior = this.pending?.alternatives || (this.pending ? [this.pending] : []);
    const linked = (candidate.alternatives || [candidate]).filter((c) => prior.some((p) =>
      c.pos >= p.pos - 3 && c.pos <= p.pos + 40));
    const continuation = linked.length > 0;
    // Two separately ambiguous phrases can uniquely identify their sequence
    // (e.g. basmala followed by al-hamd). Repeating the SAME phrase is not new
    // evidence and must not resolve ambiguity by wishful forward prediction.
    const contextual = new Set(linked.map((c) => c.ref)).size === 1 &&
      linked.some((c) => prior.some((p) => c.pos >= p.pos + 2 && c.pos <= p.pos + 40));
    if (contextual) {
      const c = linked[0];
      candidate = { ...this.matcher.result(c.pos, c.score), evidenceWords: c.evidenceWords,
        refEvidenceWords: c.refEvidenceWords, refWordCount: c.refWordCount,
        supported: c.supported, alternatives: linked, ambiguous: false };
    }
    this.confirmations = continuation ? this.confirmations + 1 : 1;
    this.pending = candidate;
    // An isolated basmala/refrain has several identical locations. Gather more
    // surrounding audio rather than falsely claiming which surah it belongs to.
    if (this.confirmations >= 2 && !candidate.ambiguous) return this.accept(candidate, observation, afterFatiha);
    return null;
  }
}
