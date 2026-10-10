import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../ai/ToolTypes";
import { registerRemoteTools } from "./RemoteToolAdapter";
test("Cloud aliases use worker RPC and overwrites document real before/after diffs", async () => {
  const files=new Map<string,string>([["existing.txt","old"]]);
  const calls:string[]=[];
  const rpc={execute:async(_run:string,name:string,args:Record<string,unknown>)=>{
    calls.push(name);
    const path=String(args.path);
    if(name==="read_file")return files.has(path)?{ok:true,output:files.get(path)}:{ok:false,error:"missing"};
    if(name==="write_file"){files.set(path,(args.append?files.get(path)??"":"")+String(args.content));return {ok:true,output:"written"};}
    if(name==="move_file"){files.set(String(args.to),files.get(String(args.from))!);files.delete(String(args.from));return {ok:true,output:"moved"};}
    return {ok:false,error:"unexpected RPC "+name};
  }};
  const registry=new ToolRegistry();registerRemoteTools(registry,rpc as any,"run-cloud","/workspace");
  const context={approval:{granted:true,scope:"once" as const,grantedBy:"user" as const}};
  for(const name of ["write_file","create_file","apply_patch"]){
    files.set("existing.txt","old");
    const result=await registry.execute(name,{path:"existing.txt",...(name==="apply_patch"?{patch:"new"}:{content:"new"})},context);
    assert.equal(result.ok,true,result.error);
    assert.equal(files.get("existing.txt"),"new");
    assert.equal(result.edit?.kind,"modify");
    assert.ok(result.edit?.diff?.some(line=>line.type==="remove"&&line.content==="old"));
    assert.ok(result.edit?.diff?.some(line=>line.type==="add"&&line.content==="new"));
  }
  const created=await registry.execute("create_file",{path:"created.txt",content:"new"},context);
  assert.equal(created.edit?.kind,"create");
  const append=await registry.execute("write_file",{path:"created.txt",content:"\nnext",append:true},context);
  assert.equal(append.edit?.kind,"modify");assert.equal(files.get("created.txt"),"new\nnext");
  assert.equal((await registry.execute("move_file",{from:"created.txt",to:"renamed.txt"},context)).ok,true);
  assert.equal(files.has("created.txt"),false);assert.equal(files.has("renamed.txt"),true);
  assert.ok(calls.includes("move_file"));assert.ok(!calls.includes("apply_patch")&&!calls.includes("create_file"),"worker write_file is the canonical contract");
  assert.equal((await registry.execute("apply_patch",{path:"a"},context)).errorType,"INVALID_ARGUMENTS");
});
