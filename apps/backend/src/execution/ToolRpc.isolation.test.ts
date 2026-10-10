import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ToolRpcChannel} from './ToolRpc';
test('a response for another run cannot resolve a pending request',async()=>{const rpc=new ToolRpcChannel();const promise=rpc.execute('owned','browser_screenshot',{},1000);const request=rpc.poll('owned')!;assert.equal(rpc.poll('other'),null);assert.equal(rpc.resolve({requestId:request.requestId,runId:'other',ok:true,durationMs:0}),false);assert.equal(rpc.resolve({requestId:request.requestId,runId:'owned',ok:true,durationMs:0}),true);assert.equal((await promise).ok,true)});
