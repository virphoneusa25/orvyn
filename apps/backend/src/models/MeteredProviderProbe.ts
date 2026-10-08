import {OpenAICompatibleAdapter,type AIModelProvider,type AIRequest,type AIChunk,type ModelConfig,type TokenUsage} from "@orvyn/ai-core";
import {ProviderVerificationStore} from "./ProviderVerificationStore";

export type ProbeOptions={allowPaidProbe?:boolean;adapter?:(config:ModelConfig)=>Pick<AIModelProvider,"stream">};
/** Operator-only bounded verification. The reservation is retained after failures or process loss. */
export function meteredProviderProbe(store:Pick<ProviderVerificationStore,"reserve"|"settle">, createAdapter:(config:ModelConfig)=>Pick<AIModelProvider,"stream"> = config=>new OpenAICompatibleAdapter(config)){
  let successfulAttempt:string|undefined;
  return {
    get successfulAttempt(){return successfulAttempt;},
    adapter(config:ModelConfig):Pick<AIModelProvider,"stream">{
      return {async *stream(request:AIRequest):AsyncIterable<AIChunk>{
        if(request.messages.some(m=>m.images?.length)||request.messages.length!==1)throw new Error("Only a single text verification request is permitted");
        const rate=config.rate;if(!rate||rate.expiresAt<=Date.now()+20_000||![rate.input,rate.output].every(n=>Number.isFinite(n)&&n>=0))throw new Error("Verification requires current exact pricing");
        const bytes=Buffer.byteLength(JSON.stringify({messages:request.messages,tools:request.tools??[]}));if(bytes>4096)throw new Error("Verification request is too large");
        const maxOutputTokens=128,inputBound=bytes*4+1024;
        const reserve=Math.max(1,Math.ceil(inputBound*rate.input+maxOutputTokens*rate.output));
        const id=await store.reserve(config,reserve);let usage:TokenUsage|undefined;let done=false,settled=false;
        try{
          const adapter=createAdapter({...config,maxOutputTokens});
          for await(const chunk of adapter.stream({...request,maxOutputTokens,signal:AbortSignal.timeout(20_000)})){
            if(chunk.usage)usage=chunk.usage;done||=chunk.done;if(chunk.error)throw new Error("Verification provider failed");yield chunk;
          }
          if(!done||!usage||![usage.promptTokens,usage.completionTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error("Verification usage is unknown");
          const cost=usage.providerCostUsd!==undefined?Math.ceil(usage.providerCostUsd*1_000_000):Math.ceil(usage.promptTokens*rate.input+usage.completionTokens*rate.output);
          await store.settle(id,cost,usage);settled=true;
          if(cost>reserve)throw new Error("Verification cost exceeded its reservation");
          successfulAttempt=id;
        }finally{if(!settled)await store.settle(id,undefined,usage);}
      }};
    },
  };
}
