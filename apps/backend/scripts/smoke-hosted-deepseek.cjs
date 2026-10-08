// Operator-only live smoke test. One bounded request, recorded in persistent provider controls.
const {ModelService}=require('../dist/services/ModelService');
const {ProviderVerificationStore}=require('../dist/models/ProviderVerificationStore');
const {meteredProviderProbe}=require('../dist/models/MeteredProviderProbe');
async function main(){
 if(process.argv.slice(2).join(' ')!=='--apply')throw new Error('Explicit --apply required');
 if(process.env.DEEPSEEK_API_KEY?.trim())throw new Error('Direct DeepSeek must be disabled');
 if(process.env.ORVYN_POSTGRES_PRIMARY_READS!=='1'||process.env.ORVYN_POSTGRES_PRIMARY_WRITES!=='1')throw new Error('PostgreSQL primary required');
 const models=new ModelService();await models.huggingFaceReady;
 const config=models.registry.get('ci:deepseek-v4-flash')?.config;if(!config?.apiKey||config.providerName!=='cheaperinference')throw new Error('Hosted DeepSeek unavailable');
 const store=new ProviderVerificationStore(process.env.DATABASE_URL||process.env.ORVYN_PG_URL);
 try{
  await store.init();const controller=meteredProviderProbe(store);let text='',usage;
  for await(const chunk of controller.adapter(config).stream({messages:[{role:'user',content:'Reply with the single word OK.'}],task:'chat',stream:true})){text+=chunk.delta||'';if(chunk.usage)usage=chunk.usage;}
  if(!controller.successfulAttempt||!text.trim()||!usage)throw new Error('Hosted DeepSeek response or usage missing; no retry');
  console.log(JSON.stringify({liveResponsePassed:true,model:config.id,provider:config.providerName,attemptId:controller.successfulAttempt,promptTokens:usage.promptTokens,completionTokens:usage.completionTokens,providerCostUsd:usage.providerCostUsd??null,responseCharacters:text.length}));
 }finally{await store.close();}
}
main().catch(()=>{console.error('Hosted DeepSeek smoke test failed; no retry; reservation retained');process.exitCode=1;});
