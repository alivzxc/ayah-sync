import { readFile } from 'node:fs/promises';

const file = process.argv[2] || 'server/cache/cpu-evaluation/results-latest.json';
const report = JSON.parse(await readFile(file, 'utf8'));
console.log(JSON.stringify(report.environment));
for (const result of report.results) {
  const item = report.corpus.find((c) => c.id === result.id);
  const delays = result.transitions.filter((t) => t.delay !== null).map((t) => t.delay).sort((a, b) => a - b);
  let stableCorrect = 0, stableTotal = 0;
  if (item.references.length) {
    for (let t = 0; t < result.testedSeconds; t += .1) {
      const expected = item.references.find((r) => t >= r.start + 2 && t < r.end - .5);
      if (!expected) continue;
      stableTotal++;
      if (result.emissions.findLast((e) => e.at <= t)?.ref === expected.ref) stableCorrect++;
    }
  }
  console.log(JSON.stringify({ id: result.id, reciter: item.reciter, method: result.method,
    ...result.summary, stableAccuracy: stableTotal ? +(stableCorrect / stableTotal * 100).toFixed(1) : null,
    switchDelayMedian: delays.length ? +delays[Math.floor(delays.length / 2)].toFixed(1) : null,
    switchDelayP90: delays.length ? +delays[Math.min(delays.length - 1, Math.floor(delays.length * .9))].toFixed(1) : null,
    source: item.source, groundTruth: item.groundTruth }));
}
