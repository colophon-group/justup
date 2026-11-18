// Seal the fixed qualification replies for their independent reviewer and
// verify the copy bound to the root operator's result receipt.
import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey,
  createPublicKey, privateDecrypt, publicEncrypt, randomBytes
} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = () => { throw new Error('Luna clarification review evidence is unavailable.'); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const LUNA_RESULT_LIMIT = 512 * 1024;

function bytes(encoded, maximum) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(maximum / 3) * 4) fail();
  const raw = Buffer.from(encoded, 'base64');
  if (!raw.length || raw.length > maximum || raw.toString('base64') !== encoded) fail();
  return raw;
}

function publicBytes(key) {
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072
      || key.asymmetricKeyDetails.publicExponent !== 65537n) fail();
  return key.export({ format: 'der', type: 'spki' });
}

export function qualificationReviewKey(encoded) {
  const original = bytes(encoded, 512);
  const key = createPublicKey({ key: original, format: 'der', type: 'spki' });
  const canonical = publicBytes(key);
  if (!canonical.equals(original)) fail();
  return { key, sha256: sha(canonical) };
}

const bindingKeys = ['runId', 'sourceCommit', 'buildIdentity', 'hostPlanSha256',
  'manifestSha256', 'grantSha256', 'reviewKeySha256'];
function associatedData(header, reportSha256) {
  return Buffer.from(JSON.stringify([...bindingKeys.map(key => header[key]), reportSha256]));
}

function reviewCases(manifest, report) {
  const expected = new Set(manifest.company.cases
    .filter(entry => entry.expectedStatus === 'clarification').map(entry => entry.id));
  const pending = report.cases.filter(record => record.manualReviewPending);
  if (expected.size !== 2 || pending.some(record => record.kind !== 'company' || record.repeatIndex !== 0
        || !expected.delete(record.id) || !hash(record.clarificationSha256))) fail();
  return pending;
}

function checkedAnswers(pending, answers) {
  if (!Array.isArray(answers) || answers.length !== pending.length) fail();
  for (const [index, item] of answers.entries()) {
    const record = pending[index];
    if (!exact(item, ['id', 'clarificationSha256', 'answer']) || item.id !== record.id
        || item.clarificationSha256 !== record.clarificationSha256
        || typeof item.answer !== 'string' || !item.answer.isWellFormed()
        || Buffer.byteLength(item.answer) > 2000
        || sha(Buffer.from(item.answer)) !== item.clarificationSha256) fail();
  }
  return answers;
}

export const qualificationReportSha = report => sha(Buffer.from(JSON.stringify(report)));
const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

export function sealQualificationAnswers({ manifest, header, report, answers, recipient }) {
  checkedAnswers(reviewCases(manifest, report), answers);
  if (!answers.length) return null;
  if (header.reviewKeySha256 !== recipient.sha256) fail();
  const plaintext = Buffer.from(JSON.stringify(answers));
  if (plaintext.length > 4800) fail();
  const secret = randomBytes(32), nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(associatedData(header, qualificationReportSha(report)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      kind: 'sealed_clarifications',
      version: 1,
      wrappedKey: publicEncrypt({ key: recipient.key, ...oaep }, secret).toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
  } finally {
    secret.fill(0);
    plaintext.fill(0);
  }
}

export function openQualificationAnswers({ header, report, sealed }, privateKey, manifest) {
  const pending = reviewCases(manifest, report);
  const key = createPrivateKey(privateKey);
  if (sha(publicBytes(createPublicKey(key))) !== header.reviewKeySha256) fail();
  if (sealed === null) return checkedAnswers(pending, []);
  if (!exact(sealed, ['kind', 'version', 'wrappedKey', 'nonce', 'tag', 'ciphertext'])
      || sealed.kind !== 'sealed_clarifications' || sealed.version !== 1) fail();
  const nonce = bytes(sealed.nonce, 12), tag = bytes(sealed.tag, 16);
  const wrapped = bytes(sealed.wrappedKey, 384);
  if (nonce.length !== 12 || tag.length !== 16 || wrapped.length !== 384) fail();
  const secret = privateDecrypt({ key, ...oaep }, wrapped);
  try {
    if (secret.length !== 32) fail();
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAAD(associatedData(header, qualificationReportSha(report)));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(bytes(sealed.ciphertext, 4800)), decipher.final()]);
    try { return checkedAnswers(pending, JSON.parse(plaintext)); }
    finally { plaintext.fill(0); }
  } finally {
    secret.fill(0);
  }
}

export function parseQualificationResult(raw, receipt) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > LUNA_RESULT_LIMIT
      || !exact(receipt, [...bindingKeys, 'resultSha256', 'reportSha256'])
      || sha(raw) !== receipt.resultSha256 || !hash(receipt.reportSha256)) fail();
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n');
  if (lines.pop() !== '' || lines.length < 2 || lines.length > 45
      || lines.some(line => !line || Buffer.byteLength(line) > 8192)) fail();
  const records = lines.map(line => JSON.parse(line));
  const header = records.shift(), summary = records.pop();
  if (!exact(header, ['version', 'kind', ...bindingKeys])
      || header.version !== 2 || header.kind !== 'luna_qualification_start'
      || !/^[a-f0-9]{32}$/u.test(header.runId) || !/^[a-f0-9]{40}$/u.test(header.sourceCommit)
      || bindingKeys.slice(2).some(key => !hash(header[key]))
      || bindingKeys.some(key => header[key] !== receipt[key])
      || !exact(summary, ['kind', 'passed', 'intent', 'company', 'totals', 'reportSha256'])
      || summary.kind !== 'summary' || typeof summary.passed !== 'boolean') fail();
  const sealed = records.at(-1)?.kind === 'sealed_clarifications' ? records.pop() : null;
  if (records.some(line => !exact(line, ['kind', 'record']) || line.kind !== 'case'
      || !line.record || !['intent', 'company'].includes(line.record.kind))) fail();
  const report = { version: 1, kind: 'luna_qualification', passed: summary.passed,
    intent: summary.intent, company: summary.company, totals: summary.totals, cases: records.map(line => line.record) };
  if (qualificationReportSha(report) !== summary.reportSha256 || summary.reportSha256 !== receipt.reportSha256) fail();
  return { header, report, sealed };
}
