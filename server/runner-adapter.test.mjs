// The queue binds root-launcher identities without reading credentials or making
// provider requests. Filesystem ownership checks remain in readRunnerConfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRunnerConfig,runnerIdentity } from './runner-adapter.mjs';

const env={JUSTUP_SOURCE_COMMIT:'a'.repeat(40),JUSTUP_BUILD_ID:'b'.repeat(64),JUSTUP_HOST_PLAN_SHA256:'c'.repeat(64)};
const config=()=>({dbPath:'/preview/state/demo.sqlite',model:{enabled:false}});

test('queue model proof and heartbeat use the exact trusted launcher identities',()=>{
  const value=bindRunnerConfig(config(),{...env,OPENAI_API_KEY:'must-not-be-copied'});
  assert.deepEqual(runnerIdentity(env),{sourceCommit:env.JUSTUP_SOURCE_COMMIT,buildIdentity:env.JUSTUP_BUILD_ID,hostPlanSha256:env.JUSTUP_HOST_PLAN_SHA256});
  assert.equal(value.sourceCommit,env.JUSTUP_SOURCE_COMMIT);assert.equal(value.buildIdentity,env.JUSTUP_BUILD_ID);
  assert.deepEqual(value.model,{enabled:false,buildIdentity:env.JUSTUP_BUILD_ID,hostPlanSha256:env.JUSTUP_HOST_PLAN_SHA256});
  assert.equal(JSON.stringify(value).includes('must-not-be-copied'),false);assert.deepEqual(config(),{dbPath:'/preview/state/demo.sqlite',model:{enabled:false}});
});

test('missing or malformed launcher identity fails closed even with model disabled',()=>{
  for(const name of Object.keys(env)){
    for(const value of [undefined,'','A'.repeat(name==='JUSTUP_SOURCE_COMMIT'?40:64),'other'])assert.throws(()=>bindRunnerConfig(config(),{...env,[name]:value}),/identity is unavailable/);
  }
});

test('operator JSON cannot duplicate or override artifact and installed-plan identities',()=>{
  for(const name of ['sourceCommit','buildIdentity','hostPlanSha256']){
    assert.throws(()=>bindRunnerConfig({...config(),[name]:'d'.repeat(64)},env),/configuration is unavailable/);
    assert.throws(()=>bindRunnerConfig({...config(),model:{[name]:'d'.repeat(64)}},env),/configuration is unavailable/);
  }
  for(const value of [{...config(),dbPath:'relative.sqlite'},{...config(),model:[]},{...config(),modulePath:'/arbitrary/plugin.mjs'}])assert.throws(()=>bindRunnerConfig(value,env),/configuration is unavailable/);
});
