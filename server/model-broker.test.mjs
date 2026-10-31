// Real local socket and injected HTTPS contracts. No credentials, DNS or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readdirSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createModelBroker,createBrokerExecutor,brokerConfigurationReady,recoverBrokerScratch,publicIpv4,fetchCompanyEvidence,verifyPublicCompanyEvidence } from './model-broker.mjs';
const data=()=>({title:'Backend',configuration:{schemaVersion:1,filters:Object.fromEntries(['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'].map(k=>[k,k==='titleAny'?['backend']:null])),residualAi:null},requirements:[{id:'r',text:'backend',handling:'primary',reason:'Title evidence.',bindings:[{field:'titleAny',values:['backend']}]} ]});
const usage={inputTokens:100,cachedInputTokens:0,outputTokens:100,reasoningOutputTokens:0};
async function fixture(t,execute,extra={}){
  const dir=mkdtempSync(join(tmpdir(),'justup-broker-')),socketPath=join(dir,'model.sock');
  const broker=createModelBroker({config:{taskCwd:'/immutable-empty'},testOnly:true,execute,...extra});await broker.listen({socketPath});
  t.after(async()=>{await broker.close();rmSync(dir,{recursive:true,force:true});});
  return {broker,socketPath,execute:createBrokerExecutor({socketPath})};
}
function wire(path,value){return new Promise((resolve,reject)=>{let result='';const socket=createConnection(path,()=>socket.write(value));socket.on('data',c=>result+=c);socket.on('end',()=>resolve(JSON.parse(result)));socket.on('error',reject);});}
test('fixed registry socket returns validated data/usage without raw tool traces or caller paths',async t=>{
  let input;const f=await fixture(t,async args=>{input=args;return {data:data(),usage,webEvents:[{private:'trace'}]};});
  const result=await f.execute({schemaId:'intent',stdin:'untrusted query',timeoutMs:1000,executable:'/bin/sh',env:{SECRET:'bad'}});
  assert.deepEqual(result.data,data());assert.deepEqual(result.usage,usage);assert.equal(JSON.stringify(result).includes('trace'),false);
  assert.equal(input.stdin,'untrusted query');assert.ok(input.args.includes('--sandbox'));assert.ok(input.args.includes('read-only'));assert.equal(input.executable,undefined);assert.equal(input.env,undefined);assert.equal(input.maxToolCalls,0);
});
test('wire rejects arbitrary schemas, commands, trailing frames and oversized input before executing',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return {data:data(),usage};});
  for(const input of [JSON.stringify({schemaId:'../../schema',prompt:'hello',timeoutMs:1000})+'\n',JSON.stringify({schemaId:'intent',prompt:'hello',timeoutMs:1000,command:'ls'})+'\n','{}\n{}\n',JSON.stringify({schemaId:'intent',prompt:'x'.repeat(25000),timeoutMs:1000})+'\n'])assert.equal((await wire(f.socketPath,input)).error.code,'invalid_input');
  assert.equal(calls,0);
});
test('broker permits one task and releases concurrency after timeout even if an adapter hangs',async t=>{
  let signal;const f=await fixture(t,args=>{signal=args.signal;return new Promise(()=>{});});
  const first=f.execute({schemaId:'intent',stdin:'one',timeoutMs:50});await new Promise(resolve=>setTimeout(resolve,10));
  await assert.rejects(()=>f.execute({schemaId:'intent',stdin:'two',timeoutMs:100}),{code:'task_limit'});
  await assert.rejects(()=>first,{code:'task_timeout'});assert.equal(signal.aborted,true);
  await assert.rejects(()=>f.execute({schemaId:'intent',stdin:'three',timeoutMs:20}),{code:'task_timeout'});
});
test('client disconnect aborts broker work; provider errors stay redacted',async t=>{
  let signal;const f=await fixture(t,args=>{signal=args.signal;return new Promise(()=>{});});const c=new AbortController(),pending=f.execute({schemaId:'intent',stdin:'one',timeoutMs:1000,signal:c.signal});await new Promise(resolve=>setTimeout(resolve,10));c.abort();await assert.rejects(()=>pending,{code:'task_timeout'});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(signal.aborted,true);
  const g=await fixture(t,()=>{throw Error('secret provider trace');});await assert.rejects(()=>g.execute({schemaId:'intent',stdin:'one',timeoutMs:1000}),e=>e.code==='provider_unavailable'&&!e.message.includes('secret'));
});
test('company candidates require independent fetched identity evidence and return bounded provenance',async t=>{
  const candidate={name:'Acme',domain:'acme.com',websiteUrl:'https://acme.com/',evidenceUrls:['https://acme.com/about']};
  for(const verified of [false,true]){
    const f=await fixture(t,async()=>({data:{status:'candidate',candidate,clarification:null},usage,webEvents:[]}),{verifyEvidence:async()=>({verified,provenance:verified?[{url:'https://acme.com/about',finalUrl:'https://acme.com/about',status:200,bytes:20,sha256:'a'.repeat(64)}]:[]})});
    if(!verified)await assert.rejects(()=>f.execute({schemaId:'company',stdin:'Acme',timeoutMs:1000}),{code:'invalid_output'});
    else {const result=await f.execute({schemaId:'company',stdin:'Acme',timeoutMs:1000});assert.equal(result.evidenceVerified,true);assert.equal(result.evidenceProvenance.length,1);}
  }
});
test('production broker cannot bind an arbitrary path and stays unavailable without protected configuration',async()=>{
  const broker=createModelBroker();assert.equal(brokerConfigurationReady({enabled:true}),false);assert.equal(broker.ready(),false);await assert.rejects(()=>broker.listen({socketPath:'/tmp/unapproved.sock'}),{code:'dependency_unavailable'});await broker.close();
});
test('startup scratch recovery removes only owned invocation directories and refuses unrelated files',t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'justup-recovery-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'task-stale'),{mode:0o700});writeFileSync(join(dir,'task-stale','private.log'),'fake prompt');recoverBrokerScratch(dir);assert.deepEqual(readdirSync(dir),[]);writeFileSync(join(dir,'unrelated.txt'),'preserve');assert.throws(()=>recoverBrokerScratch(dir),{code:'dependency_unavailable'});assert.deepEqual(readdirSync(dir),['unrelated.txt']);
});
test('public-address policy rejects private, loopback, link-local, reserved and mapped forms',()=>{
  for(const ip of ['127.0.0.1','10.0.1.2','172.20.1.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','192.0.2.1','198.18.1.1','224.1.1.1','255.255.255.255','::1','::ffff:8.8.8.8'])assert.equal(publicIpv4(ip),false,ip);
  assert.equal(publicIpv4('8.8.8.8'),true);
});
function fakeHttps(responses,onOptions=()=>{}){return (url,options,callback)=>{onOptions(url,options);const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const next=responses.shift(),res=Readable.from([Buffer.from(next.body??'')]);res.statusCode=next.status??200;res.headers=next.headers??{'content-type':'text/html'};callback(res);});return req;};}
test('HTTPS evidence pins the checked public address and retains TLS hostname verification',async()=>{
  let observed;const page=await fetchCompanyEvidence('https://acme.com/about',{resolveAddresses:async()=>['8.8.8.8'],request:fakeHttps([{body:'<h1>Acme</h1>'}],(url,options)=>{observed={url,options};})});
  assert.equal(page.status,200);assert.equal(page.bytes,13);assert.equal(page.sha256.length,64);assert.equal(observed.options.servername,'acme.com');assert.equal(observed.options.rejectUnauthorized,true);assert.equal(observed.options.agent,false);observed.options.lookup('acme.com',{},(error,ip,family)=>{assert.equal(error,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
});
test('DNS rebinding/private results, redirects escaping origin, non-HTTPS and oversized evidence fail',async()=>{
  for(const addresses of [['127.0.0.1'],['8.8.8.8','10.0.0.1'],[]])await assert.rejects(()=>fetchCompanyEvidence('https://acme.com/',{resolveAddresses:async()=>addresses,request:()=>assert.fail('Must not connect.')}),{code:'invalid_output'});
  await assert.rejects(()=>fetchCompanyEvidence('https://acme.com/',{resolveAddresses:async()=>['8.8.8.8'],request:fakeHttps([{status:302,headers:{location:'https://other.com/'}}])}),{code:'invalid_output'});
  await assert.rejects(()=>fetchCompanyEvidence('http://acme.com/'),{code:'invalid_input'});
  await assert.rejects(()=>fetchCompanyEvidence('https://acme.com/',{resolveAddresses:async()=>['8.8.8.8'],request:fakeHttps([{body:'x'.repeat(131073)}])}),{code:'output_limit'});
});
test('identity verification requires fetched official-domain text and binds URL/hash provenance',async()=>{
  const candidate={name:'Acme Labs',domain:'acme.com',evidenceUrls:['https://acme.com/about','https://unrelated.com/']},body='<h1>Acme Labs</h1>';
  let calls=0;const verified=await verifyPublicCompanyEvidence(candidate,{fetchPage:async url=>{calls++;return {url,finalUrl:url,status:200,text:body,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')};}});
  assert.equal(verified.verified,true);assert.equal(calls,1);assert.equal(verified.provenance[0].url,'https://acme.com/about');
  assert.equal((await verifyPublicCompanyEvidence(candidate,{fetchPage:async()=>({status:200,text:'Different company',sha256:'a'.repeat(64)})})).verified,false);
});
