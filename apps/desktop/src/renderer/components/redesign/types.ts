export type MissionTone="approval"|"blocked"|"paused"|"failed"|"running"|"done";
export interface MissionSummary{id:string;runId?:string;title:string;reason:string;meta:string;tone:MissionTone;label:string;stepsDone:number;stepsTotal:number;timeAgo:string;action?:string}
export interface SystemItem{id:string;name:string;description:string;icon:string;connected:boolean;cta?:string}
export interface HomeStatus{engineReady:boolean;cloudOnline:boolean;lastRun?:string;cpu?:number;ram?:number;disk?:number;agentsRunning?:number}
export interface MissionPlanItem{id:string;title:string;detail?:string;state:"done"|"active"|"pending"}
export interface ApprovalRequest{id:string;command:string;location?:string;details?:string[]}
export interface MissionDetailData{id:string;title:string;status:string;createdAt?:string;agent?:string;project?:string;plan:MissionPlanItem[];events:{id:string;kind:string;title:string;body?:string}[];approval?:ApprovalRequest;permissions?:{label:string;value:string}[];usage?:{promptTokens:number;completionTokens:number;turns:number;modelId?:string};runLog?:{sequence:number;type:string;at:number}[];files?:{path:string;action:string}[];deliverable?:string}
