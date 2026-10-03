// Run in an isolated process using the runtime's existing server-side environment.
// This prints only bounded routing, capability and usage evidence, never credentials.
const path = require('node:path');
const { ModelService } = require(path.resolve(process.argv[2] || '/app/dist', 'services/ModelService.js'));
const { selectAgentModel } = require(path.resolve(process.argv[2] || '/app/dist', 'models/selectModel.js'));
const { inferTaskIntent } = require(path.resolve(process.argv[2] || '/app/dist', 'agent/taskIntent.js'));
(async () => {
  const direct = process.argv[3] === 'fireworks';
  const expectedProvider = direct ? 'fireworks' : 'huggingface';
  if (direct) console.log(JSON.stringify({event:'fireworks.staging-config',credentialsConfigured:!!process.env.FIREWORKS_API_KEY?.trim()}));
  const service = new ModelService();
  await service.huggingFaceReady;
  const providers = service.registry.list();
  const capabilities = providers.filter(p => p.config.id.startsWith('hf:')).map(p => ({modelId:p.config.id,verification:p.config.routingVerification,context:p.config.contextWindow,tools:p.config.capabilities.tools,vision:p.config.capabilities.vision,streaming:p.config.streaming,rate:p.config.rate}));
  const choice = selectAgentModel({intent:inferTaskIntent('Fix the subtraction bug in math.js and run the unit tests'),requestedModelId:'auto',availableIds:providers.filter(p=>p.config.id!=='orvyn-mock').map(p=>p.config.id),providers});
  const provider = direct ? service.registry.get('fw:accounts/fireworks/models/deepseek-v4-flash-0731') : choice.registryId ? service.registry.get(choice.registryId) : null;
  if (direct && provider && provider.config.routingVerification?.status !== 'verified') {
    // A bounded staging-only diagnostic proves account availability even when the public catalog disagrees.
    try {
      const res = await provider.generate({messages:[{role:'user',content:'Reply with OK.'}],maxOutputTokens:16,signal:AbortSignal.timeout(15000)});
      console.log(JSON.stringify({event:'fireworks.account-availability',modelId:provider.config.id,provider:provider.config.providerName,responded:!!res.content,usage:res.usage}));
    } catch(error) {
      const status=String(error?.message||'').match(/(?:HTTP|status|error)\s*[:=]?\s*(\d{3})/i)?.[1];
      console.log(JSON.stringify({event:'fireworks.account-availability',modelId:provider.config.id,provider:provider.config.providerName,responded:false,status:status||'unavailable',reason:'Pinned route failed; no fallback was attempted'}));
    }
  }
  console.log(JSON.stringify({event:'hf.preflight.capabilities',capabilities,choice}));
  if (!provider || provider.config.providerName !== expectedProvider || provider.config.routingVerification?.status !== 'verified' || (!direct && !/Kimi-K2.7-Code/.test(provider.config.id))) { console.log(JSON.stringify({event:'provider.preflight.failed',provider:expectedProvider,reason:provider?.config.routingVerification?.reason || 'Required provider/model unavailable; fallback is not a pass'})); process.exitCode=1; return; }
  let content = 'export function add(a, b) { return a - b; }';
  let wrote=false, tested=false, passed=false, called=0;
  const messages=[{role:'user',content:'Fix the subtraction bug in math.js. Read it first, use write_file to replace it with a correct exported add(a, b) function, then call run_tests. Use the provided tools. No other files or commands are allowed.'}];
  const tools=[{name:'read_file',description:'Read a fixture file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}},{name:'write_file',description:'Write corrected fixture source',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}},{name:'run_tests',description:'Run the fixture unit tests',parameters:{type:'object',properties:{}}}];
  for(let round=0;round<6&&!passed;round++) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),55000);
    const calls=[]; let text='', reasoning='';
    try { for await(const c of provider.stream({messages,tools,stream:true,maxOutputTokens:4096,signal:controller.signal})) {text+=c.delta||'';if(c.toolCall)calls.push(c.toolCall);reasoning=c.reasoning||reasoning;} } finally {clearTimeout(timer);}
    messages.push({role:'assistant',content:text,toolCalls:calls,...(reasoning?{reasoningContent:reasoning}:{})});
    if(!calls.length) break;
    for(const call of calls) {
      called++; let result;
      if(call.argumentsError) result={ok:false,error:'Invalid tool arguments'};
      else if(call.name==='read_file'&&call.arguments.path==='math.js') result={ok:true,content};
      else if(call.name==='write_file'&&call.arguments.path==='math.js') { content=String(call.arguments.content||'');wrote=true;result={ok:true}; }
      else if(call.name==='run_tests') {tested=true;passed=wrote&&/^\s*export\s+function\s+add\s*\(\s*a\s*,\s*b\s*\)\s*\{\s*return\s+a\s*\+\s*b\s*;?\s*\}\s*$/.test(content);result={ok:passed,tests:passed?'add(2,3)=5; add(-2,3)=1; add(0,0)=0 passed':'Expected exported add(a,b) { return a + b; }; subtraction bug still fails'};}
      else result={ok:false,error:'Only math.js and the supplied tests are allowed'};
      messages.push({role:'tool',toolCallId:call.id,name:call.name,content:JSON.stringify(result)});
    }
  }
  const usage=service.usage.recent().map(e=>({modelId:e.modelId,provider:e.provider,method:e.method,ok:e.ok,promptTokens:e.promptTokens,completionTokens:e.completionTokens,cachedTokens:e.cachedTokens,estimated:e.estimated,toolCalls:e.toolCalls,rate:e.rate}));
  const evidence={event:'provider.preflight.result',passed:passed&&tested&&called>=2&&usage.length>0&&usage.every(e=>e.provider===expectedProvider&&e.ok),modelId:provider.config.id,provider:provider.config.providerName,called,wrote,tested,usage};
  console.log(JSON.stringify(evidence));
  if(!evidence.passed) process.exitCode=1;
})().catch(()=>{console.log(JSON.stringify({event:'hf.preflight.failed',reason:'Capability or bounded coding/tool smoke failed; raw provider errors withheld'}));process.exitCode=1;});
