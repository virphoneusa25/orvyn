import type { TaskIntent } from '../agent/taskIntent';
import type { ExecutionTarget } from '../execution/ExecutionTarget';
export type TaskSurface = 'local_computer' | 'cloud_desktop' | 'cloud_browser' | 'project_workspace' | 'none';
export interface SurfaceDecision { surface: TaskSurface; allowed: boolean; executionTarget?: ExecutionTarget; message?: string }
/** Authoritative task decision, before worker selection. Availability never substitutes another machine. */
export function resolveTaskSurface(input: { intent: TaskIntent; instruction: string; client: 'desktop'|'cloud'; requested: ExecutionTarget; localAuthorized: boolean; localSupported: boolean }): SurfaceDecision {
  if (input.intent.informational) return {surface:'none',allowed:true};
  const localScreen = /\b(my|this|local|actual) (?:computer|desktop|screen|window|app)\b|\b(notepad|calculator|native application|on my screen|on screen)\b/i.test(input.instruction);
  const needsDesktop = input.intent.requiresDesktop || localScreen;
  if (needsDesktop && input.client === 'desktop') {
    if (input.requested !== 'auto' && input.requested !== 'local_host') return {surface:'none',allowed:false,message:'This task needs your local computer. The selected execution target cannot access it. Choose Local explicitly to continue.'};
    if (!input.localSupported || !input.localAuthorized) return {surface:'none',allowed:false,message:'Local screen access is off or unavailable. Open Desktop, choose an app window and allow sharing, then retry. No screen was captured.'};
    return {surface:'local_computer',allowed:true,executionTarget:'local_host'};
  }
  if (input.client === 'cloud' && (input.requested === 'local_host' || input.requested === 'local_sandbox' || localScreen)) return {surface:'none',allowed:false,message:'ORVYN Cloud cannot access your physical computer. Use the installed Desktop app for this task, or choose the cloud sandbox.'};
  if (needsDesktop) return {surface:'cloud_desktop',allowed:true,executionTarget:'ovh_worker'};
  if (input.intent.requiresBrowser) return {surface:input.client === 'cloud' ? 'cloud_browser' : 'project_workspace',allowed:true,...(input.client === 'cloud' ? {executionTarget:'ovh_worker' as const} : {})};
  return {surface:input.intent.requiresWorkspace ? 'project_workspace' : 'none',allowed:true,...(input.client === 'cloud' && input.intent.requiresWorkspace ? {executionTarget:'ovh_worker' as const} : {})};
}

/** Used both when exposing a tool and immediately before executing it. */
export function surfaceToolAllowed(tool:string, client:'desktop'|'cloud'|undefined, surface:'host'|'desktop'|'browser'|'none'|undefined):boolean {
  if(!client)return true; // Older internal callers keep their existing capability policy.
  if(tool.startsWith('host_desktop_'))return client==='desktop' && surface==='host';
  if(/^(desktop_|computer[._])/.test(tool))return client==='cloud' && surface==='desktop';
  return true;
}
