// Explicit operator invocation only. Background refreshes never call this script.
const {ModelService}=require('../dist/services/ModelService');
const {ProviderVerificationStore,PROBE_DAILY_MICROS,PROBE_DAILY_REQUESTS}=require('../dist/models/ProviderVerificationStore');
const {meteredProviderProbe}=require('../dist/models/MeteredProviderProbe');
const {refreshDeepSeekRates}=require('../dist/models/deepseekRates');
const {verifyHuggingFace}=require('../dist/models/huggingFaceVerification');
const {verifyFireworksWriting,FIREWORKS_WRITING_MODEL}=require('../dist/models/fireworksVerification');
async function main(){
 const args=process.argv.slice(2),model=args.find(a=>a.startsWith('--model='))?.slice(8);
 if(!model||!args.includes('--apply')||args.some(a=>a!=='--apply'&&!a.startsWith('--model=')))throw new Error('Explicit --model=<registry-id> --apply required');
 const url=process.env.DATABASE_URL||process.env.ORVYN_PG_URL;
 if(!url||process.env.ORVYN_POSTGRES_PRIMARY_READS!=='1'||process.env.ORVYN_POSTGRES_PRIMARY_WRITES!=='1')throw new Error('PostgreSQL primary is required');
 const models=new ModelService();await models.huggingFaceReady;
 const config=models.registry.get(model)?.config;
 const verify=config?.providerName==='deepseek'?refreshDeepSeekRates:config?.providerName==='huggingface'?verifyHuggingFace:config?.providerName==='fireworks'&&config.apiModelId===FIREWORKS_WRITING_MODEL?verifyFireworksWriting:undefined;
 if(!verify||!config.apiKey)throw new Error('Unsupported or unconfigured verification target');
 const store=new ProviderVerificationStore(url);
 try{
  await store.init();const controller=meteredProviderProbe(store);
  await verify(config,{allowPaidProbe:true,adapter:controller.adapter.bind(controller)});
  if(config.routingVerification?.status!=='verified'||!controller.successfulAttempt)throw new Error('Metered capability verification failed; reservations retained');
  await store.save(config,controller.successfulAttempt);
  console.log(JSON.stringify({status:'verified',model:config.id,provider:config.providerName,dailyReservedUsd:PROBE_DAILY_MICROS/1_000_000,dailyRequests:PROBE_DAILY_REQUESTS,evidenceHours:24}));
 }finally{await store.close();}
}
main().catch(()=>{console.error('Metered verification failed; no automatic retry. Inspect protected provider controls and account balance.');process.exitCode=1;});
