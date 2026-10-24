import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preferHuggingFace, type AIModelProvider} from '@orvyn/ai-core';
import {refreshFireworksRates} from './providerRates';
function provider(id:string,name:string,input?:number,output?:number):AIModelProvider{return {config:{id,providerName:name,provider:'openai-compatible',contextWindow:64000,streaming:true,capabilities:{agent:true,tools:true,chat:true,code:true},...(input!==undefined?{rate:{input,output,source:'fixture',verifiedAt:Date.now(),expiresAt:Date.now()+60000}}:{})}} as unknown as AIModelProvider;}
const needs={capability:'agent' as const,tools:true,streaming:true};
test('Fireworks exact serverless rates include cached input and join equivalent route comparison',async()=>{
 const original=globalThis.fetch;
 const fw=provider('fw:accounts/fireworks/models/glm-5p3','fireworks');
 globalThis.fetch=(async()=>new Response('<div>$<!-- -->1.40<!-- --> /<!-- --> $0.26 /<!-- --> $<!-- -->4.40</div><div>Per <!-- -->1M Tokens (input/cached input/output)</div>')) as typeof fetch;
 try{await refreshFireworksRates([fw]);}finally{globalThis.fetch=original;}
 assert.equal(fw.config.rate?.input,1.4);assert.equal(fw.config.rate?.cachedInput,0.26);assert.equal(fw.config.rate?.output,4.4);
 const hf=provider('hf:zai-org/GLM-5.3:deepinfra','huggingface',0.9,4);
 const nebius=provider('nebius:zai-org/GLM-5.3','nebius',1.4,4.4);
 assert.equal(preferHuggingFace([fw,hf,nebius],needs,true,undefined,'advanced').provider?.config.id,hf.config.id);
 fw.config.rate!.input=0.8;fw.config.rate!.output=3.5;
 assert.equal(preferHuggingFace([fw,hf,nebius],needs,true,undefined,'advanced').provider?.config.id,fw.config.id);
 fw.config.rate!.input=0.9;fw.config.rate!.output=4;
 assert.equal(preferHuggingFace([fw,hf],needs,true,undefined,'advanced').provider?.config.id,fw.config.id);
 delete fw.config.rate;
 const unknown=preferHuggingFace([fw,hf,nebius],needs,true,undefined,'advanced');
 assert.equal(unknown.provider,undefined);assert.match(unknown.reason,/Price comparison incomplete/);
 fw.config.routingVerification={status:'failed',reason:'serverless retired'};
 const retired=preferHuggingFace([fw,hf,nebius],needs,true,undefined,'advanced');
 assert.equal(retired.provider?.config.id,hf.config.id);assert.match(retired.reason,/serverless retired/);
});
