// Admit a private operator review of the exact normalized Jobseek candidate.
// Neither an employer name, hostname nor crawler inclusion proves a verdict.
export const ORIGIN_POLICY_VERSION = 'direct-employer-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const VERDICTS = new Set(['direct_employer', 'recruitment_agency', 'repost', 'unknown']);

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function evidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function validatePostingOriginReview(review, { selection, jobs, unknownCount, verifiedAt, at }) {
  const invalid = () => { throw new Error('Invalid posting origin review.'); };
  if (!exact(review, ['schemaVersion', 'policyVersion', 'manifestSha256', 'snapshotSha256', 'reviewedAt', 'postings'])
      || review.schemaVersion !== 1 || review.policyVersion !== ORIGIN_POLICY_VERSION
      || selection?.source !== 'jobseek_feed_v1' || selection.feed?.complete !== true
      || typeof review.manifestSha256 !== 'string' || !SHA256.test(review.manifestSha256)
      || review.manifestSha256 !== selection.feed.manifestSha256
      || typeof review.snapshotSha256 !== 'string' || !SHA256.test(review.snapshotSha256)
      || !Array.isArray(review.postings) || review.postings.length !== jobs.length) invalid();
  const reviewedAt = typeof review.reviewedAt === 'string' ? Date.parse(review.reviewedAt) : NaN;
  if (!Number.isFinite(reviewedAt) || new Date(reviewedAt).toISOString() !== review.reviewedAt
      || reviewedAt < verifiedAt || reviewedAt > at) invalid();

  const unreviewed = new Map(jobs.map(({ job }) => [job.id, job]));
  const direct = new Set();
  let unknown = unknownCount > 0;
  for (const record of review.postings) {
    if (!exact(record, ['id', 'companyId', 'sourceUrl', 'verdict', 'evidenceUrl'])) invalid();
    const job = unreviewed.get(record.id);
    if (!job || record.companyId !== job.companyId || record.sourceUrl !== job.sourceUrl
        || !VERDICTS.has(record.verdict)) invalid();
    if (record.verdict === 'unknown') {
      if (record.evidenceUrl !== null) invalid();
      unknown = true;
    } else {
      if (!evidenceUrl(record.evidenceUrl)) invalid();
      if (record.verdict === 'direct_employer') direct.add(record.id);
    }
    unreviewed.delete(record.id);
  }
  return { direct, record: { policyVersion: ORIGIN_POLICY_VERSION, manifestSha256: review.manifestSha256,
    snapshotSha256: review.snapshotSha256, reviewedAt: review.reviewedAt, unknown } };
}
