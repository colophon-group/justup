// Offline manual review of the exact operator-recorded Luna result.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, realpathSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyQualificationReview, fixedQualificationManifest } from '../server/evals/luna-qualification.mjs';
import {
  LUNA_RESULT_LIMIT, openQualificationAnswers, parseQualificationResult, qualificationReportSha
} from '../server/evals/luna-qualification-review.mjs';

const fail = () => { throw new Error('Luna clarification review is unavailable.'); };

function readPrivate(path, maximum) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const meta = fstatSync(fd);
    if (!meta.isFile() || meta.uid !== process.getuid() || meta.nlink !== 1
        || ![0o400, 0o600].includes(meta.mode & 0o777) || meta.size < 1 || meta.size > maximum) fail();
    const raw = Buffer.alloc(meta.size + 1);
    let used = 0;
    while (used < raw.length) {
      const count = readSync(fd, raw, used, raw.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used !== meta.size || ['size', 'ctimeMs', 'mtimeMs'].some(key => meta[key] !== after[key])) fail();
    return raw.subarray(0, used);
  } finally { closeSync(fd); }
}

export function finalizeQualificationReview({ evidence, answers, decisions, manifest, receipt }) {
  if (!decisions || Object.keys(decisions).sort().join(',') !== 'cases,reportSha256,resultSha256'
      || decisions.resultSha256 !== receipt.resultSha256
      || decisions.reportSha256 !== qualificationReportSha(evidence.report)
      || !Array.isArray(decisions.cases) || decisions.cases.length !== answers.length
      || !decisions.cases.every(item => answers.some(answer => answer.id === item?.id
        && answer.clarificationSha256 === item?.clarificationSha256))) fail();
  const review = { version: 1, kind: 'luna_qualification_manual_review',
    reportSha256: decisions.reportSha256, cases: decisions.cases };
  const report = applyQualificationReview({ manifest, report: evidence.report, receipt: review });
  return { kind: 'luna_qualification_reviewed', version: 1, operatorReceipt: receipt, review, report };
}

function escapeFormatCharacter(character) {
  let escaped = '';
  for (let index = 0; index < character.length; index++) {
    escaped += '\\u' + character.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return escaped;
}

function main([command, resultPath, receiptPath, keyPath, decisionsPath, output, ...extra]) {
  if (!['inspect', 'finalize'].includes(command) || !keyPath || extra.length
      || (command === 'inspect' ? decisionsPath !== undefined || !process.stdout.isTTY : !decisionsPath || !output)) fail();
  const receipt = JSON.parse(readPrivate(receiptPath, 8192));
  const evidence = parseQualificationResult(readPrivate(resultPath, LUNA_RESULT_LIMIT), receipt);
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== evidence.header.sourceCommit) fail();
  execFileSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--']);
  const { manifest, sha256 } = fixedQualificationManifest();
  if (sha256 !== evidence.header.manifestSha256) fail();
  const key = readPrivate(keyPath, 16_384);
  let answers;
  try { answers = openQualificationAnswers(evidence, key); }
  finally { key.fill(0); }
  if (!answers.length) fail();
  if (command === 'inspect') {
    const view = { resultSha256: receipt.resultSha256, reportSha256: receipt.reportSha256, answers };
    const escaped = JSON.stringify(view, null, 2).replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu, escapeFormatCharacter);
    process.stdout.write(escaped + '\n');
    return;
  }
  if (!isAbsolute(output) || resolve(output) !== output || realpathSync(dirname(output)) !== dirname(output)) fail();
  const decisions = JSON.parse(readPrivate(decisionsPath, 8192));
  const final = finalizeQualificationReview({ evidence, answers, decisions, manifest, receipt });
  writeFileSync(output, JSON.stringify(final, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: final.report.passed, reportSha256: qualificationReportSha(final.report) }) + '\n');
  if (!final.report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch {
    process.stderr.write('Luna clarification review did not complete.\n');
    process.exitCode = 1;
  }
}
