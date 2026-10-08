import test from "node:test";
import assert from "node:assert/strict";
import type {ModelConfig,AIRequest,AIChunk} from "@orvyn/ai-core";
import {meteredProviderProbe} from "./MeteredProviderProbe";
const config={id:"fixture",rate:{input:1,output:2,expiresAt:Date.now()+600_000}} as ModelConfig;
const request={messages:[{role:"user",content:"Verify"}],stream:true,maxOutputTokens:9999} as AIRequest;
async function drain(chunks:AsyncIterable<AIChunk>){for await(const _ of chunks){}}
test("probe reserves before sending, bounds output and settles reported usage",async()=>{
 const events:string[]=[];
 const controller=meteredProviderProbe({reserve:async()=>{events.push("reserve");return "id";},settle:async(id,cost)=>{events.push("settle");assert.equal(cost,14);}},()=>({async *stream(r){events.push("send");assert.equal(r.maxOutputTokens,128);yield {delta:"",done:true,usage:{promptTokens:10,completionTokens:2}};}}));
 await drain(controller.adapter(config).stream(request));assert.deepEqual(events,["reserve","send","settle"]);assert.equal(controller.successfulAttempt,"id");
});
test("missing usage and provider failure retain uncertain reservations",async()=>{
 for(const failure of [false,true]){
 let settled=false;
 const controller=meteredProviderProbe({reserve:async()=>"id",settle:async(id,cost)=>{settled=true;assert.equal(cost,undefined);}},()=>({async *stream(){if(failure)throw new Error("failure");yield {delta:"",done:true};}}));
 await assert.rejects(drain(controller.adapter(config).stream(request)));assert.equal(settled,true);assert.equal(controller.successfulAttempt,undefined);
 }
});
test("budget rejection, images and expiring prices never contact provider",async()=>{
 let contacted=0;
 const controller=meteredProviderProbe({reserve:async()=>{throw new Error("budget");},settle:async()=>{}},()=>({async *stream(){contacted++;yield {delta:"",done:true};}}));
 await assert.rejects(drain(controller.adapter(config).stream(request)),/budget/);
 await assert.rejects(drain(controller.adapter({...config,rate:{...config.rate!,expiresAt:Date.now()+1000}}).stream(request)),/pricing/);
 await assert.rejects(drain(controller.adapter(config).stream({...request,messages:[{role:"user",content:"Verify",images:[{url:"fixture"}]}]})));
 assert.equal(contacted,0);
});
test("over-reservation settlement cannot produce successful evidence",async()=>{
 let cost:number|undefined;
 const controller=meteredProviderProbe({reserve:async()=>"id",settle:async(id,value)=>{cost=value;}},()=>({async *stream(){yield {delta:"",done:true,usage:{promptTokens:10,completionTokens:2,providerCostUsd:1}};}}));
 await assert.rejects(drain(controller.adapter(config).stream(request)),/exceeded/);assert.equal(cost,1_000_000);assert.equal(controller.successfulAttempt,undefined);
});
