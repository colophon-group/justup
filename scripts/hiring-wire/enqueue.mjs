// Weekly scheduler entry point: enqueue only into the existing application queue.
// It has no provider or automation activation and never reads account records.
import { lstatSync,realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../../server/store.mjs';
import { createTasks } from '../../server/tasks.mjs';
import { createHiringWireService } from '../../server/hiring-wire.mjs';
import { DAY,periodFor,wireError } from '../../server/hiring-wire-facts.mjs';

export function latestWirePeriodEnd(at=Date.now()) {
  const date=new Date(at);if(!Number.isFinite(date.getTime()))throw wireError('invalid_input');
  const midnight=Math.floor(date.getTime()/DAY)*DAY,daysSinceMonday=(date.getUTCDay()+6)%7;
  return new Date(midnight-daysSinceMonday*DAY).toISOString();
}
export function enqueueWeekly({env=process.env,args=process.argv.slice(2),now=Date.now}={}) {
  if(args.length!==0 && (args.length!==2 || args[0]!=='--period'))throw wireError('invalid_input');
  const periodEnd=args[1]??latestWirePeriodEnd(now());periodFor(periodEnd);
  const path=env.JUSTUP_DB_PATH;
  if(typeof path!=='string' || !isAbsolute(path) || realpathSync(path)!==path || !lstatSync(path).isFile() || ![undefined,'true','false'].includes(env.JUSTUP_SHARED_STATE))throw wireError('dependency_unavailable');
  const store=openStore(path,{sharedState:env.JUSTUP_SHARED_STATE==='true'});
  try {
    const tasks=createTasks({db:store.db,now}),service=createHiringWireService({db:store.db,tasks,now});
    const task=service.enqueuePeriod(periodEnd);
    return {taskId:task.id,status:task.status,periodEnd};
  } finally {store.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.stdout.write(`${JSON.stringify(enqueueWeekly())}\n`);}
  catch{process.stderr.write('Hiring Wire could not be queued.\n');process.exitCode=1;}
}
