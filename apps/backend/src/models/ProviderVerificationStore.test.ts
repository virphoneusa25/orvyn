import test from "node:test";
import assert from "node:assert/strict";
import {Pool} from "pg";
import type {ModelConfig} from "@orvyn/ai-core";
import {ProviderVerificationStore} from "./ProviderVerificationStore";
const url=process.env.ORVYN_PG_URL;
test("persistent provider verification serializes limits and preserves uncertain reservations",{skip:process.env.ORVYN_PROVIDER_VERIFICATION_TEST!=="1"},async()=>{
 assert.ok(url);assert.equal(new URL(url).pathname,"/provider_controls_test");
 const admin=new Pool({connectionString:url});
 const first=new ProviderVerificationStore(url),second=new ProviderVerificationStore(url);
 const config={id:"fixture",apiModelId:"fixture",providerName:"huggingface",endpoint:"https://fixture.invalid",apiKey:"synthetic-only",contextWindow:4096,streaming:true,capabilities:{chat:true,code:true,agent:true,tools:true,completion:true,vision:false},rate:{input:1,output:1,expiresAt:Date.now()+600000}} as ModelConfig;
 try{
  await first.init();
  const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?first:second).reserve(config,1000)));
  const accepted=attempts.filter((r):r is PromiseFulfilledResult<string>=>r.status==="fulfilled");assert.equal(accepted.length,4);
  await first.settle(accepted[0].value,10,{promptTokens:5,completionTokens:5});await first.save(config,accepted[0].value);
  assert.equal((await second.evidence(config))?.context,4096);
  assert.equal(await second.evidence({...config,apiKey:"another"}),undefined);
  assert.equal(await second.evidence({...config,endpoint:"https://another.invalid"}),undefined);
  await assert.rejects(second.reserve({...config,endpoint:"https://another.invalid"},1),/exhausted/);
  await first.settle(accepted[1].value,undefined,undefined);
  await assert.rejects(first.save(config,accepted[1].value));
  await assert.rejects(first.save(config,accepted[2].value));
  await first.close();const reopened=new ProviderVerificationStore(url);
  try{await assert.rejects(reopened.reserve(config,1),/exhausted/);assert.ok(await reopened.evidence(config));}finally{await reopened.close();}
  const expensive={...config,apiKey:"cost-limit"};await second.reserve(expensive,30000);await assert.rejects(second.reserve(expensive,20001),/exhausted/);
  await admin.query("UPDATE orvyn_provider_controls.verifications SET expires_at=0");assert.equal(await second.evidence(config),undefined);
  await admin.query("UPDATE orvyn_provider_controls.probe_attempts SET created_at=now()-interval '2 days'");assert.ok(await second.reserve(config,1));
 }finally{await first.close().catch(()=>{});await second.close();await admin.query("DROP SCHEMA IF EXISTS orvyn_provider_controls CASCADE");await admin.end();}
});
