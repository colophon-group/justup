// Local read-only projection check. Output is limited to counts and an evidence
// hash; a schema-valid input does not authorize or establish source continuity.
import { constants,openSync,closeSync,fstatSync,readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileWireSnapshot,wireError } from '../../server/hiring-wire-facts.mjs';
export function checkSnapshot({args=process.argv.slice(2),now=Date.now}={}) {
  if(args.length!==3 || !isAbsolute(args[0]) || args[1]!=='--period')throw wireError('invalid_input');
  let fd;
  try {
    fd=openSync(args[0],constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(fd);
    if(!before.isFile() || before.nlink!==1 || before.size<1 || before.size>4*1024*1024)throw wireError('invalid_output');
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw wireError('invalid_output');
    const compiled=compileWireSnapshot(JSON.parse(bytes),{periodEnd:args[2],now:now()});
    return {periodEnd:compiled.period.end,snapshotSha256:compiled.snapshotSha256,comparableCompanies:compiled.facts.length,suppressedScopes:compiled.suppressed.length};
  } finally {if(fd!==undefined)closeSync(fd);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.stdout.write(`${JSON.stringify(checkSnapshot())}\n`);}
  catch{process.stderr.write('Hiring Wire history could not be verified.\n');process.exitCode=1;}
}
