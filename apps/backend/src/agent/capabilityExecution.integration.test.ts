import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AIChunk, AIRequest, AIResponse, ModelConfig } from "@orvyn/ai-core";
import { ToolRegistry } from "../ai/ToolTypes";
import { makeReadFileTool, makeWriteFileTool, makeApplyPatchTool } from "../ai/tools/fileTools";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { McpManager } from "../mcp/McpManager";
import { RunStore } from "./events";
import { StreamingAgentRuntime } from "./StreamingAgentRuntime";

class Provider {
  readonly requests: AIRequest[] = [];
  readonly config: ModelConfig = { id:"fw:accounts/fireworks/models/kimi-k2p7-code",name:"Runtime fixture",provider:"openai-compatible",endpoint:"http://localhost:0",contextWindow:128000,maxOutputTokens:4000,defaultTemperature:0,defaultTopP:1,streaming:true,capabilities:{chat:true,code:true,agent:true,tools:true,vision:false,embeddings:false,completion:false,image:false} };
  constructor(private turns: AIChunk[][]) {}
  async *stream(request: AIRequest) { this.requests.push(JSON.parse(JSON.stringify({messages:request.messages,tools:request.tools}))); for(const chunk of this.turns.shift()??[{delta:"Done.",done:true}])yield chunk; }
  async generate():Promise<AIResponse>{return {content:"VERDICT: PASS\n- fixture",finishReason:"stop"};}
  supportsTools(){return true;} supportsVision(){return false;} async healthCheck(){return {status:"online" as const};}
}
const call=(id:string,name:string,args:Record<string,unknown>):AIChunk[]=>[{delta:"",toolCall:{id,name,arguments:args},done:false},{delta:"",done:true}];
function fixture(turns:AIChunk[][]) {
  const root=mkdtempSync(join(tmpdir(),"orvyn-capability-exec-"));
  const registry=new ToolRegistry(), engine=new PermissionEngine(), gateway=new ToolGateway(registry,engine), store=new RunStore(), provider=new Provider(turns);
  const service={router:{resolve:()=>provider},registry:{get:(id:string)=>id===provider.config.id?provider:undefined,list:()=>[provider]}} as any;
  const runtime=new StreamingAgentRuntime(service,gateway,store);
  return {root,registry,engine,gateway,store,provider,runtime};
}
async function settle(store:RunStore,id:string) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){const status=store.get(id)?.status;if(status&&!["running","awaiting_approval","verifying"].includes(status))return status;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("Runtime did not settle");
}
test("native create_file/apply_patch calls execute and record accurate durable file events",async()=>{
  const h=fixture([call("create","create_file",{path:"notes.txt",content:"first"}),call("patch","apply_patch",{path:"notes.txt",patch:"second"}),call("read","read_file",{path:"notes.txt"}),[{delta:"Read back second from notes.txt.",done:true}]]);
  h.registry.register(makeReadFileTool(h.root));h.registry.register(makeWriteFileTool(h.root));h.gateway.registerAlias("create_file","write_file");h.registry.register(makeApplyPatchTool(h.root));
  try{
    const id=await h.runtime.start(h.root,"Create notes.txt, replace its contents, and read it back",undefined,"agent",undefined,[],undefined,undefined,{accessMode:"full_access"});
    await settle(h.store,id);
    assert.equal(readFileSync(join(h.root,"notes.txt"),"utf8"),"second");
    const events=h.store.get(id)!.events;
    assert.deepEqual(events.filter(event=>event.type==="file.edit").map(event=>(event.data.preview as any)?.kind),["create","modify"]);
    assert.equal(events.filter(event=>event.type==="file.created").length,1);
    assert.ok(!events.some(event=>event.type==="tool.failed"),JSON.stringify(events.filter(event=>event.type==="tool.failed")));
    assert.ok(h.provider.requests.some(request=>request.messages.some(message=>message.role==="tool"&&String(message.content).includes("second"))));
  }finally{rmSync(h.root,{recursive:true,force:true});}
});
test("agent discovers then calls a REAL connected MCP child process on a generic task",async()=>{
  const script=join(process.cwd(),`orvyn-runtime-mcp-${Date.now()}.cjs`);
  writeFileSync(script,`const {McpServer}=require("@modelcontextprotocol/sdk/server/mcp.js");const {StdioServerTransport}=require("@modelcontextprotocol/sdk/server/stdio.js");const {z}=require("zod");const s=new McpServer({name:"runtime-fixture",version:"1"});s.tool("echo_message",{message:z.string()},async({message})=>({content:[{type:"text",text:"REAL_MCP:"+message}]}));s.connect(new StdioServerTransport());`);
  const h=fixture([call("discover","search_capabilities",{query:"connected fixture data"}),call("echo","mcp.runtimefixture.echo_message",{message:"agent roundtrip"}),[{delta:"Verified the connected tool result.",done:true}]]);
  const map=new Map<string,string>();
  const manager=new McpManager({gateway:h.gateway,engine:h.engine,store:{getSetting:(key:string)=>map.get(key)??null,setSetting:(key:string,value:string)=>{map.set(key,value);},deleteSetting:(key:string)=>{map.delete(key);}} as any);
  let serverId="";
  try{
    const cfg=await manager.addServer({name:"runtimefixture",transport:"stdio",command:process.execPath,args:[script]});serverId=cfg.id;
    const connected=await manager.connect(serverId);assert.equal(connected.state,"CONNECTED",connected.lastError);
    h.registry.register({name:"search_capabilities",description:"Find the connected fixture capability",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]},defaultPermission:"allowed",async execute(){return {ok:true,output:"Activated connected fixture",meta:{activated:["mcp.runtimefixture.echo_message"]}};}});
    const id=await h.runtime.start(h.root,"Read the connected fixture data",undefined,"agent",undefined,[],undefined,undefined,{approvedTools:["mcp.runtimefixture.echo_message"]});
    await settle(h.store,id);
    const events=h.store.get(id)!.events;
    assert.ok(events.some(event=>event.type==="mcp.activation"));
    assert.ok(events.some(event=>event.type==="tool.completed"&&event.data.tool==="mcp.runtimefixture.echo_message"),JSON.stringify(events.filter(event=>event.type==="tool.failed")));
    assert.ok(!h.provider.requests[0]?.tools?.some(tool=>tool.name==="mcp.runtimefixture.echo_message"),"generic turn starts with bounded discovery");
    assert.ok(h.provider.requests[1]?.tools?.some(tool=>tool.name==="mcp.runtimefixture.echo_message"),"discovery exposes the callable schema");
    assert.ok(h.provider.requests.some(request=>request.messages.some(message=>message.role==="tool"&&String(message.content).includes("REAL_MCP:agent roundtrip"))));
  }finally{if(serverId)await manager.disconnect(serverId);rmSync(script,{force:true});rmSync(h.root,{recursive:true,force:true});}
});
