import type { AgentEvent } from "../AgentActivityList";
import type { MissionDetailData, MissionPlanItem } from "./types";

export interface ApiMissionDetail {
  id:string; runId:string; goal:string; status:string; createdAt:number|string; updatedAt:number|string;
  tasks:{id:string;description:string;agent:string;status:string;attempts:number;reviewNotes?:string}[];
}
function planState(status:string):MissionPlanItem["state"] {
  const s=status.toUpperCase();
  if(s==="COMPLETED") return "done";
  if(["RUNNING","PLANNING","WAITING","TESTING","REVIEW","REWORK"].includes(s)) return "active";
  return "pending";
}
export function missionDetailFromRuntime(m:ApiMissionDetail, events:AgentEvent[]):MissionDetailData {
  const files=new Map<string,string>();
  const activity:{id:string;kind:string;title:string;body?:string}[]=[];
  let approval:MissionDetailData["approval"];
  let deliverable:string|undefined;
  for(const e of events){
    if(e.type==="file.read"||e.type==="file.edit"){
      const p=String(e.data.path??e.data.preview?.path??""); if(p) files.set(p,e.type==="file.read"?"read":"edit");
    }
    if(e.type==="approval.required"){
      const input=e.data.input??{}; const command=String(input.command??input.path??e.data.tool??"");
      approval={id:String(e.data.callId??e.id),command,location:e.data.tool?String(e.data.tool):undefined,details:[e.data.destructive?"Destructive action":"Approval required"]};
    }
    if(e.type==="approval.resolved" && approval && String(e.data.callId??"")===approval.id) approval=undefined;
    if(e.type==="terminal.started") activity.push({id:e.id,kind:"terminal",title:`Running ${String(e.data.command??"command")}`});
    if(e.type==="terminal.completed") activity.push({id:e.id,kind:"terminal",title:e.data.exitOk===false?"Command failed":"Command completed"});
    if(e.type==="assistant.message"||e.type==="assistant.completed"){
      const body=String(e.data.content??e.data.text??"").trim(); if(body) activity.push({id:e.id,kind:"assistant",title:"ORION",body});
    }
    if(e.type==="run.completed") deliverable=String(e.data.summary??e.data.result??"Mission completed.");
    if(e.type==="run.error") activity.push({id:e.id,kind:"error",title:"Run failed",body:String(e.data.message??"Unknown error")});
  }
  return {id:m.id,title:m.goal,status:m.status,createdAt:new Date(typeof m.createdAt==="number"&&m.createdAt<1e12?m.createdAt*1000:m.createdAt).toISOString(),agent:"ORION",plan:m.tasks.map(t=>({id:t.id,title:t.description,detail:t.reviewNotes??(t.attempts?`${t.attempts} attempt${t.attempts===1?"":"s"}`:undefined),state:planState(t.status)})),events:activity.slice(-40),approval,permissions:[{label:"Read files",value:"Allowed"},{label:"Run commands",value:"Ask"},{label:"Network",value:"Ask"},{label:"Deploy",value:"Off"}],files:Array.from(files,([path,action])=>({path,action})),deliverable};
}
