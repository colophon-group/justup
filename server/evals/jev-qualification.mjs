// Fixed held-out sequence and redacted scoring through the ordinary JEV budget
// boundary. A host entrypoint must isolate and authorize each execution.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { CLASSIFIER_VERSION, JEV_MODEL, JevError, createJevClient, planJevBatch } from '../jev.mjs';
import { JEV_ATTEMPT_INPUT_TOKENS } from '../jev-budget.mjs';

const repeats = 3;
const ownerId = 'qualification:jev-heldout-v1';
const decisions = ['accepted', 'rejected', 'insufficient_evidence'];
const fixtureUrl = new URL('./matching-cases-v1.json', import.meta.url);
// The synthetic excerpts are shorter than the runtime's 200-character evidence
// floor. Supply identical surrounding context with no facts about the employer.
const context = 'This synthetic job listing is for a fictional employment position used in a quality evaluation. The excerpt below contains the evidence to examine. It is followed by no additional information about the position.\n\n';
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = data => createHash('sha256').update(data).digest('hex');

function fixedSuite() {
  const bytes = readFileSync(fixtureUrl);
  const fixture = JSON.parse(bytes);
  const cases = fixture.cases?.filter(entry => entry.split === 'heldout');
  if (fixture.schemaVersion !== 1 || fixture.providerMeasured !== false
      || fixture.acceptanceForFutureProviderRun?.minimumRepeatedRuns !== repeats
      || fixture.acceptanceForFutureProviderRun?.acceptedPrecision !== 1
      || fixture.acceptanceForFutureProviderRun?.ambiguousFalseAccepts !== 0
      || cases?.length !== 6 || new Set(cases.map(entry => entry.id)).size !== 6
      || cases.some(entry => !/^held-[a-z-]+$/u.test(entry.id) || !decisions.includes(entry.expected)
        || typeof entry.condition !== 'string' || typeof entry.evidence !== 'string')) {
    throw new Error('The fixed JEV qualification cases changed.');
  }
  const groups = Map.groupBy(cases, entry => entry.condition);
  if (groups.size !== 2 || [...groups.values()].some(group => group.length !== 3
      || new Set(group.map(entry => entry.expected)).size !== decisions.length)) {
    throw new Error('JEV qualification requires two ternary held-out groups.');
  }
  const batches = [...groups].map(([condition, group]) => {
    const jobs = group.map(entry => ({ id: entry.id, title: 'Synthetic position', companyName: 'Synthetic employer',
      bodyText: context + entry.evidence, evidenceHash: hash(context + entry.evidence),
      evidence: { aiEligible: true, truncated: false } }));
    if (planJevBatch(condition, jobs).selected.length !== jobs.length) throw new Error('A qualification case exceeds provider bounds.');
    return { condition, group, jobs };
  });
  return { fixtureSha256: hash(bytes), batches };
}

function publicAttempt(result, group, elapsedMs) {
  const ids = new Set(group.map(entry => entry.id));
  if (result.model !== JEV_MODEL || result.classifierVersion !== CLASSIFIER_VERSION
      || result.attempts !== 1 || result.ambiguousAttempts !== 0
      || result.cumulativeReservedInputTokens !== JEV_ATTEMPT_INPUT_TOKENS
      || !count(result.cumulativeReservationNanodollars) || result.cumulativeReservationNanodollars === 0
      || !count(result.usage?.inputTokens) || !count(result.usage?.outputTokens) || !count(result.costNanodollars)
      || result.decisions?.length !== group.length
      || result.decisions.some(row => !ids.delete(row.id) || !decisions.includes(row.decision))) {
    throw new Error('Qualification provider evidence is invalid.');
  }
  return { elapsedMs, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    costNanodollars: result.costNanodollars, reservedNanodollars: result.cumulativeReservationNanodollars,
    outcomes: group.map(entry => ({ caseId: entry.id, expected: entry.expected,
      observed: result.decisions.find(row => row.id === entry.id).decision })) };
}

function score(attempts, requiredCalls) {
  const outcomes = attempts.flatMap(attempt => attempt.outcomes);
  const accepts = outcomes.filter(row => row.observed === 'accepted');
  const correctAccepts = accepts.filter(row => row.expected === 'accepted').length;
  const ambiguousFalseAccepts = accepts.filter(row => row.expected === 'insufficient_evidence').length;
  const repeated = [...Map.groupBy(outcomes, row => row.caseId)].map(([caseId, rows]) => ({
    caseId, observed: rows.map(row => row.observed), varies: new Set(rows.map(row => row.observed)).size > 1,
  }));
  const latency = attempts.map(attempt => attempt.elapsedMs).sort((a, b) => a - b);
  const percentile = p => latency[Math.ceil(latency.length * p) - 1] ?? null;
  const sum = key => attempts.reduce((total, attempt) => total + attempt[key], 0);
  const acceptedPrecision = accepts.length ? correctAccepts / accepts.length : null;
  const status = accepts.length > correctAccepts ? 'fail'
    : attempts.length === requiredCalls && accepts.length ? 'pass' : 'insufficient_evidence';
  return { status, requiredCalls, completedCalls: attempts.length, expectedDecisions: requiredCalls * 3,
    observedDecisions: outcomes.length, exactDecisions: outcomes.filter(row => row.expected === row.observed).length,
    acceptedPrecision, ambiguousFalseAccepts, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    knownCostNanodollars: sum('costNanodollars'), confirmedReservedNanodollars: sum('reservedNanodollars'),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), repeated };
}

export async function qualifyJevHeldout({ db, config, signal, fetch }) {
  const { fixtureSha256, batches } = fixedSuite();
  const client = createJevClient({ db, config: { ...config, maxRetries: 0 }, fetch });
  const requiredCalls = batches.length * repeats;
  const attempts = [];
  let interruption = null;
  for (let round = 1; round <= repeats && !interruption; round++) {
    for (const { condition, group, jobs } of batches) {
      if (signal?.aborted) { interruption = { code: 'cancelled', attempts: 0, ambiguousAttempts: 0 }; break; }
      const start = performance.now();
      try {
        const result = await client.classify({ ownerId, condition, jobs, signal });
        attempts.push({ round, ...publicAttempt(result, group, Math.ceil(performance.now() - start)) });
      } catch (error) {
        interruption = error instanceof JevError
          ? { code: error.code, attempts: error.attempts, ambiguousAttempts: error.ambiguousAttempts }
          : { code: 'qualification_contract', attempts: null, ambiguousAttempts: null };
        break;
      }
    }
  }
  return { schemaVersion: 1, fixtureSha256, model: JEV_MODEL, classifierVersion: CLASSIFIER_VERSION,
    ...score(attempts, requiredCalls), attempts, interruption };
}
