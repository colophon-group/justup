// Hiring Wire's fixed bidirectional protocol on the existing private broker
// socket. The parent broker owns the one shared slot, auth-only invocation and
// cleanup. This module never listens, reads credentials, or accepts commands.
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { randomUUID } from 'node:crypto';
import { exact,plain,token,wireError } from './hiring-wire-facts.mjs';
import { WIRE_PROFILE_DESCRIPTOR } from './hiring-wire-editorial.mjs';
import { wireDescriptorMatches,wireProfileReady } from './hiring-wire-codex-policy.mjs';

const MAX_FRAME=270_336,MAX_SESSION=4_194_304,CANCEL_TIMEOUT_MS=5000;
const SAFE=new Set(['dependency_unavailable','provider_unavailable','invalid_input','invalid_output','task_timeout','output_limit','tool_limit','tool_not_allowed','token_limit','task_limit']);
const code=error=>SAFE.has(error?.code)?error.code:'provider_unavailable';
const problem=value=>wireError(SAFE.has(value)?value:'invalid_input');
function frame(value,max=MAX_FRAME) {let data;try{data=JSON.stringify(value);}catch{throw problem('invalid_input');}if(typeof data!=='string'||Buffer.byteLength(data)>max)throw problem('output_limit');return `${data}\n`;}
export function validateWireOpen(value) {
  exact(value,['profile','operation','executionId','descriptor']);token(value.executionId);
  if(value.profile!=='hiring_wire'||value.operation!=='open'||!wireDescriptorMatches(value.descriptor))throw problem('invalid_input');
  return value;
}
export function validWireConfiguration(value) {
  try {
    if(value===undefined)return true;
    if(value?.enabled===false){exact(value,['enabled']);return true;}
    exact(value,['enabled','attestationPath','providerCatalogueSha256','modelUid','socketPath']);
    return value.enabled===true&&isAbsolute(value.attestationPath)&&isAbsolute(value.socketPath)&&Number.isSafeInteger(value.modelUid)&&value.modelUid>0&&/^[a-f0-9]{64}$/u.test(value.providerCatalogueSha256);
  }catch{return false;}
}
// Called only after the parent atomically reserves its existing shared slot.
// openSession returns {session,dispose}; dispose preserves scoped auth refresh
// through the parent's unchanged auth validator, then removes the invocation.
export function handleHiringWireCodexConnection(socket,{firstFrame,openSession,release,signal}={}) {
  const open=validateWireOpen(firstFrame),controller=new AbortController(),decoder=new TextDecoder('utf-8',{fatal:true});
  let session,dispose,bytes=0,buffer='',active=false,finished=false,cleanupPromise,openedPromise;
  let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});
  const timeout=setTimeout(()=>void finish('task_timeout'),WIRE_PROFILE_DESCRIPTOR.maxMs);
  const abort=()=>void finish('task_timeout');signal?.addEventListener('abort',abort,{once:true});
  function write(value,end=false){if(!socket.destroyed){const data=frame(value,75_000);end?socket.end(data):socket.write(data);}}
  async function finish(error,finalResponse,cancelled=false) {
    if(cleanupPromise)return cleanupPromise;
    finished=true;controller.abort();clearTimeout(timeout);signal?.removeEventListener('abort',abort);
    cleanupPromise=(async()=>{
      let cleanupError;
      try{await openedPromise;}catch(error){if(error?.code==='cleanup_unproven')cleanupError='cleanup_unproven';}
      try{await session?.cancel();}catch{cleanupError='cleanup_unproven';}
      try{await dispose?.();}catch{cleanupError='cleanup_unproven';}
      // A failed cleanup quarantines the shared slot. Neither a socket close nor
      // a failure reply grants the queue permission to hand it to foreground work.
      if(!cleanupError)try{await release();}catch{cleanupError='cleanup_unproven';}
      try {
        if(error||cleanupError)write({ok:false,executionId:open.executionId,error:{code:cleanupError??error},cleanup:cleanupError?'unproven':'complete'},true);
        else if(cancelled)write({ok:true,executionId:open.executionId,type:'cancelled'},true);
        else if(finalResponse)write({ok:true,executionId:open.executionId,response:finalResponse,cleanup:'complete'},true);
        else if(!socket.destroyed)socket.end();
      }catch{socket.destroy();}
      finally{resolveDone();}
    })();return cleanupPromise;
  }
  socket.on('error',()=>void finish('dependency_unavailable'));
  socket.once('close',()=>void finish('task_timeout'));
  socket.on('data',chunk=>{
    if(finished)return;
    bytes+=chunk.length;if(bytes>MAX_SESSION){void finish('output_limit');return;}
    try {
      buffer+=decoder.decode(chunk,{stream:true});let end;
      while(!finished&&(end=buffer.indexOf('\n'))>=0) {
        if(Buffer.byteLength(buffer.slice(0,end))>MAX_FRAME)throw problem('invalid_input');
        const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        if(!plain(value)||value.profile!=='hiring_wire'||value.executionId!==open.executionId)throw problem('invalid_input');
        if(value.operation==='cancel') {exact(value,['profile','operation','executionId']);void finish(undefined,undefined,true);return;}
        exact(value,['profile','operation','executionId','request']);
        if(value.operation!=='step'||active||!session||value.request?.executionId!==open.executionId)throw problem('invalid_input');active=true;
        Promise.resolve().then(()=>{if(!finished)return session.step(value.request,{signal:controller.signal});}).then(response=>{
          if(finished)return;
          if(!plain(response)||!['tools','final'].includes(response.type))throw problem('invalid_output');
          if(response.type==='final')void finish(undefined,response);
          else write({ok:true,executionId:open.executionId,response});
        }).catch(error=>void finish(code(error))).finally(()=>{active=false;});
      }
      if(Buffer.byteLength(buffer)>MAX_FRAME)void finish('output_limit');
    }catch(error){void finish(SAFE.has(error?.code)?error.code:'invalid_input');}
  });
  openedPromise=Promise.resolve().then(async()=>{
    if(signal?.aborted)throw problem('task_timeout');
    const opened=await openSession();session=opened.session;dispose=opened.dispose;
    if(typeof session?.step!=='function'||typeof session?.cancel!=='function')throw problem('dependency_unavailable');
    if(!finished)write({ok:true,executionId:open.executionId,type:'opened'});
  });
  void openedPromise.catch(error=>void finish(code(error)));
  return {done,cancel:()=>finish('task_timeout')};
}

// Low-level protocol client has no qualification method. Application composition
// must use createHiringWireCodexTransport, whose production path checks proof.
export function createHiringWireCodexClient({socketPath,executionId}={}) {
  if(!isAbsolute(socketPath))throw problem('invalid_input');token(executionId);
  let socket,buffer='',bytes=0,waiter,opening,terminal=false,pendingStep=false,deadlineTimer,cancelTimer;
  let cleanupProven=false,cancelling=false,cancellation,resolveCancellation,rejectCancellation;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  function stop(error,proven=false) {
    cleanupProven||=proven;terminal=true;clearTimeout(deadlineTimer);clearTimeout(cancelTimer);socket?.destroy();
    if(waiter){const current=waiter;waiter=null;current.reject(error??problem('task_timeout'));}
    if(cancellation){cleanupProven?resolveCancellation():rejectCancellation(wireError('cleanup_unproven'));}
  }
  function reply(kind) {if(waiter)throw problem('task_limit');return new Promise((resolve,reject)=>{waiter={resolve,reject,kind};});}
  function connect() {
    opening=(async()=>{
      const response=reply('open');socket=createConnection({path:socketPath});
      deadlineTimer=setTimeout(()=>void cancel().catch(()=>{}),WIRE_PROFILE_DESCRIPTOR.maxMs);
      socket.once('connect',()=>socket.write(frame({profile:'hiring_wire',operation:'open',executionId,descriptor:WIRE_PROFILE_DESCRIPTOR},2048)));
      socket.on('error',()=>stop(problem('dependency_unavailable')));socket.once('end',()=>stop(problem('provider_unavailable')));
      socket.once('close',()=>{if(!terminal)stop(problem('dependency_unavailable'));});
      socket.on('data',chunk=>{
        if(terminal)return;bytes+=chunk.length;if(bytes>1_048_576){stop(problem('output_limit'));return;}
        try {
          buffer+=decoder.decode(chunk,{stream:true});let end;
          while(!terminal&&(end=buffer.indexOf('\n'))>=0) {
            if(Buffer.byteLength(buffer.slice(0,end))>75_000)throw problem('invalid_output');
            const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
            if(!plain(value)||value.executionId!==executionId||typeof value.ok!=='boolean')throw problem('invalid_output');
            if(!value.ok) {
              exact(value,['ok','executionId','error','cleanup']);exact(value.error,['code']);
              if(buffer.trim())throw problem('invalid_output');
              if(value.error.code==='cleanup_unproven'&&value.cleanup==='unproven'){stop(wireError('cleanup_unproven'));return;}
              if(!SAFE.has(value.error.code)||value.cleanup!=='complete')throw problem('invalid_output');
              stop(problem(value.error.code),true);return;
            }
            if(value.type==='cancelled') {
              exact(value,['ok','executionId','type']);if(!cancelling||buffer.trim())throw problem('invalid_output');
              stop(problem('task_timeout'),true);return;
            }
            if(value.type==='opened') {
              exact(value,['ok','executionId','type']);if(waiter?.kind!=='open')throw problem('invalid_output');
            }else {
              const response=value.response;
              if(!plain(response)||!['tools','final'].includes(response.type))throw problem('invalid_output');
              if(Buffer.byteLength(JSON.stringify(response))>WIRE_PROFILE_DESCRIPTOR.maxOutputBytes)throw problem('output_limit');
              if(response.type==='final') {
                exact(value,['ok','executionId','response','cleanup']);exact(response,['type','data']);if(value.cleanup!=='complete'||buffer.trim())throw problem('invalid_output');
                const current=waiter;if(!cancelling&&current?.kind!=='step')throw problem('invalid_output');waiter=null;
                stop(undefined,true);current?.resolve(value);return;
              }
              exact(value,['ok','executionId','response']);
              exact(response,['type','calls']);if(!Array.isArray(response.calls)||!response.calls.length||response.calls.length>4)throw problem('invalid_output');
              if(cancelling)continue;
              if(waiter?.kind!=='step')throw problem('invalid_output');
            }
            const current=waiter;waiter=null;current.resolve(value);
          }
          if(Buffer.byteLength(buffer)>75_000)throw problem('output_limit');
        }catch(error){stop(problem(SAFE.has(error?.code)?error.code:'invalid_output'));}
      });
      const value=await response;exact(value,['ok','executionId','type']);if(value.type!=='opened')throw problem('invalid_output');
    })();return opening;
  }
  async function step(request,{signal}={}) {
    if(terminal||pendingStep)throw problem(terminal?'dependency_unavailable':'task_limit');pendingStep=true;
    const abort=()=>void cancel().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
    try {
      if(signal?.aborted)throw problem('task_timeout');if(!opening)connect();await opening;
      if(cancelling)throw problem('task_timeout');
      const response=reply('step');socket.write(frame({profile:'hiring_wire',operation:'step',executionId,request}));
      const result=await response;
      return result.response;
    }catch(error){await cancel();throw problem(code(error));}
    finally{pendingStep=false;signal?.removeEventListener('abort',abort);}
  }
  function cancel() {
    if(cancellation)return cancellation;
    cancelling=true;clearTimeout(deadlineTimer);
    cancellation=new Promise((resolve,reject)=>{resolveCancellation=resolve;rejectCancellation=reject;});
    if(!socket){stop(undefined,true);return cancellation;}
    if(terminal){stop();return cancellation;}
    if(waiter?.kind==='step'){const current=waiter;waiter=null;current.reject(problem('task_timeout'));}
    cancelTimer=setTimeout(()=>stop(wireError('cleanup_unproven')),CANCEL_TIMEOUT_MS);
    // Opening may still be pending. Do not pipeline a cancel into the parent's
    // first-frame admission; the eventual open must be disposed and acknowledged.
    void opening.then(()=>{
      if(terminal)return;
      try{socket.write(frame({profile:'hiring_wire',operation:'cancel',executionId},2048));}
      catch{stop(wireError('cleanup_unproven'));}
    },()=>stop());
    return cancellation;
  }
  return {step,cancel};
}
export function createHiringWireCodexTransport({config={}}={}) {
  const clients=new Map();let lastCancellation;
  const qualified=descriptor=>wireProfileReady(config,descriptor);
  function cancel(executionId) {
    if(lastCancellation?.executionId===executionId)return lastCancellation.promise;
    const client=clients.get(executionId);
    const promise=(client?.cancel()??Promise.resolve()).then(()=>{clients.delete(executionId);});
    lastCancellation={executionId,promise};return promise;
  }
  return {
    qualified,executionId:()=>randomUUID(),
    async step(request,options) {
      if(!qualified(request?.descriptor))throw problem('dependency_unavailable');token(request.executionId);
      if(lastCancellation?.executionId===request.executionId)throw problem('dependency_unavailable');
      if(!clients.has(request.executionId)) {
        if(clients.size)throw problem('task_limit');
        clients.set(request.executionId,createHiringWireCodexClient({socketPath:config.socketPath,executionId:request.executionId}));
      }
      try{return await clients.get(request.executionId).step(request,options);}
      catch(error){await cancel(request.executionId);throw error;}
    },
    cancel
  };
}
