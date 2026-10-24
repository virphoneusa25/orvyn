/** Serialize one run's async planning and prevent publication after cancellation. */
export class WorkerAdmission {
  private pending=new Map<string,{cancelled:boolean;promise:Promise<void>}>();
  run(runId:string,plan:(current:()=>boolean)=>Promise<void>):Promise<void> {
    const previous=this.pending.get(runId);
    if(previous&&!previous.cancelled)return previous.promise;
    const admission={cancelled:false,promise:undefined as unknown as Promise<void>};
    this.pending.set(runId,admission);
    admission.promise=Promise.resolve().then(()=>plan(()=>!admission.cancelled&&this.pending.get(runId)===admission)).finally(()=>{
      if(this.pending.get(runId)===admission)this.pending.delete(runId);
    });
    return admission.promise;
  }
  cancel(runId:string):void {
    const admission=this.pending.get(runId);if(admission)admission.cancelled=true;
  }
}
