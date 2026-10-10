type Control={owner:'user'|'orion';fresh:boolean};
const controls=new Map<string,Control>();
export function browserControl(runId:string):Control {return controls.get(runId)??{owner:'orion',fresh:true}}
export function setBrowserControl(runId:string,owner:'user'|'orion'){controls.set(runId,{owner,fresh:false})}
export function clearBrowserControl(runId:string){controls.delete(runId)}
export function checkBrowserAction(runId:string,tool:string):string|undefined {
  if(!tool.startsWith('browser_'))return;
  const control=browserControl(runId);
  if(tool==='browser_screenshot' || tool==='browser_evidence' || tool==='browser_console_errors') return;
  if(control.owner==='user') return 'The user has control of this browser. Wait until they return control.';
  if(!control.fresh)return 'Control was returned. Take a fresh browser_screenshot before acting.';
}
export function markBrowserFrame(runId:string){const c=controls.get(runId);if(c?.owner==='orion')c.fresh=true}
