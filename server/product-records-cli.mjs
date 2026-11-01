// Local operator-only reports and explicit reviewed-case curation. This CLI has
// no HTTP endpoint, provider invocation, credential loader or private-row export.
import { DatabaseSync } from 'node:sqlite';
import { lstatSync,readFileSync,realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productReport } from './product-records.mjs';
import { checkedCase,compareEvaluation,createEvaluationRecords,exportCases } from './evaluation-records.mjs';

const MAX_BYTES=4*1024*1024;
function file(path) {
  if(!isAbsolute(path)||realpathSync(path)!==path)throw new Error('Use a canonical absolute local file.');
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw new Error('Input file exceeds the bounded local contract.');
  return JSON.parse(readFileSync(path,'utf8'));
}
export function runProductRecordsCli(args) {
  const [flag,path,command='report',...inputs]=args;
  if(flag!=='--db'||!isAbsolute(path??'')||realpathSync(path)!==path||!lstatSync(path).isFile()||!['report','cases-export','cases-import','compare'].includes(command)||inputs.length!==({report:0,'cases-export':0,'cases-import':1,compare:2}[command]))throw new Error('Use --db /existing/private.sqlite [report|cases-export|cases-import /reviewed.json|compare /baseline.json /candidate.json].');
  const db=new DatabaseSync(path,{readOnly:command!=='cases-import'});
  try {
    let result;
    if(command==='report')result=productReport({db});
    if(command==='cases-export')result=exportCases({db});
    if(command==='compare')result=compareEvaluation(exportCases({db}).cases,file(inputs[0]),file(inputs[1]));
    if(command==='cases-import') {
      const data=file(inputs[0]);if(!data||data.version!==1||!Array.isArray(data.cases)||data.cases.length>200)throw new Error('Use a bounded reviewed case bundle.');
      data.cases.forEach(checkedCase);
      if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_evaluation_cases'").get())throw new Error('Initialize the composed application collections first.');
      const collection=createEvaluationRecords({db,ownerAuthority:()=>null});
      db.exec('BEGIN IMMEDIATE');
      try{const imported=data.cases.reduce((n,row)=>n+Number(collection.importCase(row)),0);db.exec('COMMIT');result={version:1,imported};}catch(error){db.exec('ROLLBACK');throw error;}
    }
    const output=JSON.stringify(result);if(Buffer.byteLength(output)>MAX_BYTES)throw new Error('Report exceeds its export bound.');return output;
  }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{console.log(runProductRecordsCli(process.argv.slice(2)));}catch{console.error('Product record command failed. Check bounded local inputs and initialized storage.');process.exitCode=1;}
}
