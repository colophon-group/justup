// One leased model task at a time. Embedders inject handlers; no polling schedule,
// provider credential loading or production process is started by importing this file.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function createRunner({tasks,handlers,workerId=`runner-${randomUUID()}`,leaseMs=30_000,taskTimeoutMs=90_000,pollMs=1000,onMetric=()=>{},beforeClaim=()=>{}}={}) {
  if(!tasks||!handlers||Object.values(handlers).some(h=>typeof h!=='function')||typeof beforeClaim!=='function'||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>300_000||!Number.isInteger(taskTimeoutMs)||taskTimeoutMs<1||taskTimeoutMs>120_000||!Number.isInteger(pollMs)||pollMs<10||pollMs>60_000) throw new TypeError('Invalid runner configuration.');
  let busy=false,controller=null;
  async function runOnce({signal}={}) {
    if(busy||signal?.aborted)return false;
    busy=true;let task,timer,heartbeat,preemption,abort;
    try {
      const maintenance=beforeClaim();if(maintenance?.then)await maintenance;
      if(signal?.aborted)return false;
      task=tasks.claim({workerId,kinds:Object.keys(handlers),leaseMs});
      if(!task)return false;
      controller=new AbortController();
      let rejectBoundary;
      const boundary=new Promise((_,reject)=>{rejectBoundary=reject;});
      const stop=(code)=>{const reason=Object.assign(new Error('Task boundary ended.'),{code});controller?.abort(reason);rejectBoundary(reason);};
      abort=()=>stop('task_timeout');signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>stop('task_timeout'),taskTimeoutMs);
      heartbeat=setInterval(()=>{try{if(!tasks.heartbeat(task.id,task.leaseToken,leaseMs))stop('revision_conflict');}catch{stop('task_interrupted');}},Math.max(250,Math.floor(leaseMs/3)));
      controller.signal.addEventListener('abort',()=>rejectBoundary(controller.signal.reason??Object.assign(new Error('Task aborted.'),{code:'task_timeout'})),{once:true});
      if(task.kind==='hiring_wire'&&typeof tasks.hasForeground==='function'&&typeof tasks.pauseWire==='function') {
        const check=()=>{try{if(!controller.signal.aborted&&tasks.hasForeground())stop('task_preempted');}catch{stop('task_interrupted');}};
        preemption=setInterval(check,Math.min(pollMs,250));check();
      }
      let result;
      const handling=Promise.resolve().then(()=>handlers[task.kind](task,{signal:controller.signal}));
      try {result=await Promise.race([handling,boundary]);}
      catch(error){
        // Wire owns a native shared-slot invocation. Never release its queue
        // lease or start foreground work until its cancellation has settled.
        if(task.kind==='hiring_wire')try{await handling;}catch{}
        result={status:'failed',errorCode:['task_timeout','revision_conflict','task_interrupted'].includes(error.code)?error.code:'task_failed'};
      }
      if(task.kind==='hiring_wire'&&controller.signal.reason?.code==='task_preempted') {
        const paused=tasks.pauseWire(task.id,task.leaseToken);
        try{onMetric({kind:task.kind,code:paused?'task_preempted':'lease_lost'});}catch{}
        return true;
      }
      if(!result||!['succeeded','warning','failed'].includes(result.status))result={status:'failed',errorCode:'invalid_output'};
      const terminal=result.committed===true?tasks.get(task.ownerId,task.id):null;
      const completed=result.committed===true
        ? terminal?.status===result.status&&JSON.stringify(terminal.output)===JSON.stringify(result.output??null)
        : tasks.complete(task.id,task.leaseToken,{status:result.status,output:result.output??null,errorCode:result.errorCode??null});
      try{onMetric({kind:task.kind,code:completed?result.errorCode??result.status:'lease_lost'});}catch{}
      return true;
    } finally {clearTimeout(timer);clearInterval(heartbeat);clearInterval(preemption);signal?.removeEventListener('abort',abort);controller=null;busy=false;}
  }
  async function run({signal}={}) {
    tasks.recover();
    while(!signal?.aborted){const worked=await runOnce({signal});if(!worked)try{await delay(pollMs,undefined,{signal});}catch{break;}}
  }
  return {runOnce,run,stop:()=>controller?.abort(Object.assign(new Error('Runner stopped.'),{code:'task_timeout'})),ready:()=>!busy,workerId};
}

// CLI bootstrap is a fixed reviewed module. Operator JSON supplies bounded
// configuration, never a module, command or browser/model-supplied path.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const shutdown=new AbortController();process.once('SIGTERM',()=>shutdown.abort());process.once('SIGINT',()=>shutdown.abort());let deps;
  try{const module=await import('./runner-adapter.mjs');deps=await module.createRunnerDependencies();await createRunner(deps).run({signal:shutdown.signal});}
  catch{console.error('Runner could not start.');process.exitCode=1;}
  finally{await deps?.close?.();}
}
