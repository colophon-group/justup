// Fixed-registry Unix-socket broker for a dedicated model UID. Read before
// provisioning its socket/auth: it must have no API, SQLite, JEV or admin access.
import { createServer,createConnection,BlockList,isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Resolver } from 'node:dns/promises';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,lstatSync,readdirSync,realpathSync,chmodSync } from 'node:fs';
import { isAbsolute,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { CODEX_VERSION,codexArguments,codexEnvironment,executeCodex,validateModelData } from './model-runner.mjs';
import { validateCompanyUrl } from './companies.mjs';

const schemas={intent:new URL('./model-schemas/intent.schema.json',import.meta.url),company:new URL('./model-schemas/company.schema.json',import.meta.url)};
const SAFE=new Set(['dependency_unavailable','provider_unavailable','invalid_input','invalid_output','task_timeout','output_limit','tool_limit','tool_not_allowed','token_limit','task_limit']);
const problem=(code)=>Object.assign(new Error('Model research is unavailable.'),{code:SAFE.has(code)?code:'provider_unavailable'});
const plain=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const code=(e)=>SAFE.has(e?.code)?e.code:'provider_unavailable';
const schema=(id)=>JSON.parse(readFileSync(schemas[id],'utf8'));
function abortable(promise,signal){return new Promise((resolveValue,reject)=>{if(signal?.aborted){reject(problem('task_timeout'));return;}let timer;const abort=()=>{timer=setTimeout(()=>reject(problem('task_timeout')),250);};signal?.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolveValue,reject).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);});});}
function frame(value,max){const data=JSON.stringify(value);if(Buffer.byteLength(data)>max)throw problem('output_limit');return `${data}\n`;}
function requestData(value){if(!plain(value)||Object.keys(value).sort().join(',')!=='prompt,schemaId,timeoutMs'||!Object.hasOwn(schemas,value.schemaId)||typeof value.prompt!=='string'||!value.prompt.trim()||Buffer.byteLength(value.prompt)>24_576||value.prompt.includes('\0')||!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1||value.timeoutMs>60_000)throw problem('invalid_input');return value;}
function usageData(value){const keys=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Number.isSafeInteger(value[k])||value[k]<0))throw problem('invalid_output');return Object.fromEntries(keys.map(k=>[k,value[k]]));}

// Pin HTTPS to a resolved public IPv4 address while preserving TLS hostname
// validation. IPv6-only sites stay unresolved rather than using an unsafe fallback.
const denied=new BlockList();
for(const [net,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(net,prefix,'ipv4');
export const publicIpv4=(address)=>isIP(address)===4&&!denied.check(address,'ipv4');
async function addresses(host){const resolver=new Resolver({timeout:1500,tries:1});try{return await resolver.resolve4(host);}finally{resolver.cancel();}}
export async function fetchCompanyEvidence(url,{signal,resolveAddresses=addresses,request=httpsRequest}={}) {
  const initial=new URL(validateCompanyUrl(url,{official:true})),deadline=AbortSignal.timeout(5000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  let current=initial;
  for(let redirects=0;redirects<=2;redirects++){
    const found=await abortable(resolveAddresses(current.hostname),combined);
    if(!Array.isArray(found)||!found.length||found.length>32||found.some(ip=>!publicIpv4(ip)))throw problem('invalid_output');
    const response=await new Promise((resolveResponse,reject)=>{
      const req=request(current,{method:'GET',agent:false,servername:current.hostname,rejectUnauthorized:true,signal:combined,
        lookup:(_hostname,_options,callback)=>callback(null,found[0],4),headers:{'user-agent':'JustupPreviewEvidence/1','accept':'text/html,application/xhtml+xml,text/plain'}},res=>{
        const status=res.statusCode;
        if([301,302,303,307,308].includes(status)){res.resume();resolveResponse({status,location:res.headers.location});return;}
        const mime=(res.headers['content-type']??'').split(';')[0].toLowerCase();
        if(status!==200||!['text/html','application/xhtml+xml','text/plain'].includes(mime)||Number(res.headers['content-length']??0)>131_072){res.destroy();reject(problem('invalid_output'));return;}
        const chunks=[];let bytes=0;
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131_072){res.destroy();reject(problem('output_limit'));}else chunks.push(chunk);});
        res.once('error',()=>reject(problem('provider_unavailable')));res.once('end',()=>resolveResponse({status,text:Buffer.concat(chunks).toString('utf8'),bytes}));
      });
      req.once('error',()=>reject(problem(combined.aborted?'task_timeout':'provider_unavailable')));req.end();
    });
    if(response.location){const next=new URL(response.location,current);validateCompanyUrl(next.href,{official:true});if(next.origin!==initial.origin||redirects===2)throw problem('invalid_output');current=next;continue;}
    if(typeof response.text!=='string'||!response.text.trim())throw problem('invalid_output');
    return {url:initial.href,finalUrl:current.href,status:200,bytes:response.bytes,text:response.text,sha256:createHash('sha256').update(response.text).digest('hex')};
  }
  throw problem('invalid_output');
}
export async function verifyPublicCompanyEvidence(candidate,{signal,fetchPage=fetchCompanyEvidence}={}) {
  if(!plain(candidate)||typeof candidate.name!=='string'||typeof candidate.domain!=='string'||!Array.isArray(candidate.evidenceUrls))return {verified:false,provenance:[]};
  const urls=candidate.evidenceUrls.filter(url=>{try{const host=new URL(validateCompanyUrl(url,{official:true})).hostname;return host===candidate.domain||host.endsWith(`.${candidate.domain}`);}catch{return false;}}).slice(0,2);
  const identity=candidate.name.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  if(identity.length<2||!urls.length)return {verified:false,provenance:[]};
  const provenance=[];
  for(const url of urls){
    let page;try{page=await fetchPage(url,{signal});}catch{continue;}
    const plainText=page.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu,' ').replace(/<[^>]*>/gu,' ').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ');
    if(page.status===200&&plainText.includes(identity)&&/^[a-f0-9]{64}$/.test(page.sha256))provenance.push({url:page.url,finalUrl:page.finalUrl,status:200,bytes:page.bytes,sha256:page.sha256});
  }
  return {verified:provenance.length>0,provenance};
}

function protectedDirectory(path,{root=false,immutable=false}={}){if(!isAbsolute(path)||realpathSync(path)!==path)throw problem('dependency_unavailable');const s=lstatSync(path);if(!s.isDirectory()||s.uid!==(root?0:process.getuid())||(s.mode&(immutable?0o222:0o077))!==0)throw problem('dependency_unavailable');}
export function recoverBrokerScratch(invocationRoot){
  protectedDirectory(invocationRoot);
  const paths=readdirSync(invocationRoot).map(name=>({name,path:join(invocationRoot,name)}));
  for(const {name,path} of paths){const meta=lstatSync(path);if(!/^task-[A-Za-z0-9]+$/.test(name)||!meta.isDirectory()||meta.isSymbolicLink()||meta.uid!==process.getuid())throw problem('dependency_unavailable');}
  for(const {path} of paths)rmSync(path,{recursive:true,force:true,maxRetries:1});
}
function subscriptionAuth(bytes){
  if(bytes.length>65_536)throw problem('dependency_unavailable');let auth;try{auth=JSON.parse(bytes);}catch{throw problem('dependency_unavailable');}
  if(!plain(auth)||auth.auth_mode!=='chatgpt'||auth.OPENAI_API_KEY!=null||!plain(auth.tokens)||['access_token','refresh_token'].some(k=>typeof auth.tokens[k]!=='string'||!auth.tokens[k]||auth.tokens[k].length>16_384))throw problem('dependency_unavailable');
  return bytes;
}
export function brokerConfigurationReady(config){
  try{
    if(config.enabled!==true||config.cliVersion!==CODEX_VERSION||process.getuid()===0)return false;
    protectedDirectory(config.protectedAuthHome);protectedDirectory(config.invocationRoot);protectedDirectory(config.taskCwd,{root:true,immutable:true});
    if(readdirSync(config.taskCwd).length||readdirSync(config.protectedAuthHome).some(n=>n!=='auth.json'))return false;
    for(const path of [config.codexPath,join(config.protectedAuthHome,'auth.json')]){if(realpathSync(path)!==path)return false;const s=lstatSync(path);if(!s.isFile()||s.uid!==(path===config.codexPath?0:process.getuid())||(s.mode&(path===config.codexPath?0o022:0o077))!==0)return false;}
    subscriptionAuth(readFileSync(join(config.protectedAuthHome,'auth.json')));
    return true;
  }catch{return false;}
}
export function createModelBroker({config={},execute=executeCodex,verifyEvidence=verifyPublicCompanyEvidence,testOnly=false}={}){
  let busy=false;const controllers=new Set(),sockets=new Set();
  async function perform(input,signal){
    if(!testOnly&&!brokerConfigurationReady(config))throw problem('dependency_unavailable');
    let invocation=null,auth=null;
    try{
      let env;
      if(!testOnly){
        invocation=mkdtempSync(join(config.invocationRoot,'task-'));chmodSync(invocation,0o700);
        const home=join(invocation,'home'),scratch=join(invocation,'scratch');mkdirSync(home,{mode:0o700});mkdirSync(scratch,{mode:0o700});
        auth=subscriptionAuth(readFileSync(join(config.protectedAuthHome,'auth.json')));writeFileSync(join(home,'auth.json'),auth,{mode:0o600,flag:'wx'});
        env={...codexEnvironment({codexHome:home,taskCwd:config.taskCwd}),TMPDIR:scratch};
      }
      const kind=input.schemaId==='intent'?'search_intent':'company_resolution';
      const result=await abortable(execute({executable:config.codexPath,args:codexArguments({kind,schemaPath:schemas[input.schemaId].pathname,taskCwd:config.taskCwd??'/empty'}),cwd:config.taskCwd,env,stdin:input.prompt,signal,timeoutMs:Math.min(input.timeoutMs,input.schemaId==='company'?60_000:30_000),allowWeb:input.schemaId==='company',maxToolCalls:input.schemaId==='company'?6:0}),signal);
      if(validateModelData(result.data,schema(input.schemaId)).length)throw problem('invalid_output');
      const usage=usageData(result.usage);
      let evidenceVerified=false,provenance=[];
      if(input.schemaId==='company'&&result.data.status==='candidate'){
        const proof=await abortable(verifyEvidence(result.data.candidate,{signal,webEvents:result.webEvents}),signal);evidenceVerified=proof?.verified===true;provenance=proof?.provenance??[];
        if(!evidenceVerified)throw problem('invalid_output');
      }
      // Preserve only scoped subscription refresh state. Rollouts/logs/cache and
      // prompt-containing files stay inside the invocation and are removed below.
      return {ok:true,data:result.data,usage,evidenceVerified,evidenceProvenance:provenance};
    }finally{
      try{if(invocation){const refreshed=subscriptionAuth(readFileSync(join(invocation,'home','auth.json'))),temp=join(config.protectedAuthHome,`.auth-${randomUUID()}`);try{writeFileSync(temp,refreshed,{mode:0o600,flag:'wx'});renameSync(temp,join(config.protectedAuthHome,'auth.json'));}finally{refreshed.fill(0);rmSync(temp,{force:true});}}}
      finally{auth?.fill(0);if(invocation)rmSync(invocation,{recursive:true,force:true,maxRetries:1});}
    }
  }
  const server=createServer(socket=>{
    sockets.add(socket);
    socket.setTimeout(5000,()=>socket.destroy());const decoder=new StringDecoder('utf8');let buffer='',bytes=0,started=false;
    const controller=new AbortController();controllers.add(controller);
    const reply=value=>{if(!socket.destroyed)try{socket.end(frame(value,75_000));}catch{socket.destroy();}};
    socket.on('error',()=>{});socket.once('close',()=>{controller.abort();controllers.delete(controller);sockets.delete(socket);});
    socket.on('data',chunk=>{
      if(started){controller.abort();socket.destroy();return;}
      bytes+=chunk.length;if(bytes>32_768){reply({ok:false,error:{code:'invalid_input'}});return;}
      buffer+=decoder.write(chunk);const end=buffer.indexOf('\n');if(end<0)return;
      started=true;socket.setTimeout(0);
      let input;try{if(buffer.slice(end+1).trim())throw problem('invalid_input');input=requestData(JSON.parse(buffer.slice(0,end)));}catch{reply({ok:false,error:{code:'invalid_input'}});return;}
      if(busy){reply({ok:false,error:{code:'task_limit'}});return;}busy=true;
      const timeout=setTimeout(()=>controller.abort(),Math.min(input.timeoutMs,60_000));
      perform(input,controller.signal).then(reply,error=>reply({ok:false,error:{code:code(error)}})).finally(()=>{clearTimeout(timeout);busy=false;});
    });
  });
  server.maxConnections=8;
  async function listen({fd,socketPath}={}){
    if(fd!==3&&!(testOnly&&typeof socketPath==='string'&&isAbsolute(socketPath)))throw problem('dependency_unavailable');
    if(!testOnly){if(!brokerConfigurationReady(config))throw problem('dependency_unavailable');recoverBrokerScratch(config.invocationRoot);}
    await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(fd===3?{fd}:socketPath,()=>{server.removeListener('error',reject);resolveListen();});});
    if(socketPath)chmodSync(socketPath,0o600);
  }
  async function close(){for(const controller of controllers)controller.abort();for(const socket of sockets)socket.destroy();await new Promise(resolveClose=>server.close(()=>resolveClose()));}
  return {listen,close,ready:()=>!busy&&brokerConfigurationReady(config)};
}

export function createBrokerExecutor({socketPath}={}){
  if(!isAbsolute(socketPath))throw new TypeError('An absolute broker socket is required.');
  return function execute({schemaId,stdin,timeoutMs,signal}={}){
    let input;try{input=requestData({schemaId,prompt:stdin,timeoutMs});}catch(error){return Promise.reject(error);}
    return new Promise((resolveReply,reject)=>{
      if(signal?.aborted){reject(problem('task_timeout'));return;}
      const socket=createConnection({path:socketPath}),decoder=new StringDecoder('utf8');let buffer='',bytes=0,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolveReply(value);};
      const abort=()=>finish(problem('task_timeout'));signal?.addEventListener('abort',abort,{once:true});
      socket.setTimeout(timeoutMs+15_000,()=>finish(problem('task_timeout')));
      socket.once('connect',()=>socket.write(frame(input,32_768)));
      socket.on('error',()=>finish(problem('dependency_unavailable')));socket.once('end',()=>{if(!settled)finish(problem('invalid_output'));});
      socket.on('data',chunk=>{
        bytes+=chunk.length;if(bytes>75_000)return finish(problem('output_limit'));buffer+=decoder.write(chunk);const end=buffer.indexOf('\n');if(end<0)return;
        try{if(buffer.slice(end+1).trim())throw problem('invalid_output');const r=JSON.parse(buffer.slice(0,end));if(!plain(r)||typeof r.ok!=='boolean')throw problem('invalid_output');if(!r.ok)throw problem(r.error?.code);if(validateModelData(r.data,schema(schemaId)).length)throw problem('invalid_output');const usage=usageData(r.usage);finish(null,{data:r.data,usage,evidenceVerified:r.evidenceVerified===true,evidenceProvenance:r.evidenceProvenance??[]});}catch(error){finish(problem(code(error)));}
      });
    });
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);let broker;
  try{
    if(process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw problem('dependency_unavailable');
    const path=process.env.JUSTUP_MODEL_BROKER_CONFIG;if(!isAbsolute(path)||realpathSync(path)!==path)throw problem('dependency_unavailable');const meta=lstatSync(path);if(!meta.isFile()||meta.uid!==0||(meta.mode&0o022)!==0||meta.size>16_384)throw problem('dependency_unavailable');
    const config=JSON.parse(readFileSync(path,'utf8'));broker=createModelBroker({config});await broker.listen({fd:3});
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>broker.close().then(()=>process.exit(0)));
  }catch{console.error('Model broker could not start.');process.exitCode=1;await broker?.close();}
}
