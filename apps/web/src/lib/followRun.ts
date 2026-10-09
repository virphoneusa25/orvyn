import { readSseStream } from "./sse.ts";
export interface RunEvent {runId?:string; sequence:number; type:string; data?:Record<string, any>}
export function eventCursor(runId:string, initial=0) {
  let sequence=initial;
  return {get sequence(){return sequence}, accept(event:RunEvent){
    if (event.runId && event.runId!==runId || !Number.isFinite(event.sequence) || event.sequence<=sequence) return false;
    sequence=event.sequence; return true;
  }};
}
export async function followRun(runId:string, token:string|null, signal:AbortSignal, initial:number, onEvent:(event:RunEvent)=>void) {
  const cursor=eventCursor(runId,initial);
  let failures=0, ended=false;
  while (!signal.aborted && !ended) {
    try {
      const response=await fetch(`/api/v1/agent/stream/runs/${encodeURIComponent(runId)}/events?after=${cursor.sequence}`,{headers:token?{Authorization:`Bearer ${token}`}:{},signal,cache:"no-store"});
      if (!response.ok || !response.body) throw new Error(`Progress stream unavailable (${response.status})`);
      await readSseStream(response.body, raw=>{
        const event=raw as RunEvent;
        if(signal.aborted || !cursor.accept(event)) return;
        failures=0; onEvent(event);
        ended=/^run\.(completed|partial|error|cancelled)$/.test(event.type) || event.type==='run.blocked' && event.data?.terminal===true;
      });
    } catch(error) {if(signal.aborted) return; if(++failures>=6) throw error;}
    if(!ended && !signal.aborted) await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve()}; const timer=setTimeout(finish,Math.min(400*2**failures,5000));signal.addEventListener('abort',finish,{once:true})});
  }
}
