import React from 'react';
import { NativeDesktopSession } from './NativeDesktopSession';
/** Desktop always targets the local computer. Cloud workspace lives in the web client. */
export function DesktopView({ active = true }: { projectRoot: string | null; active?: boolean; runId?: string | null; cursor?: { x:number; y:number; kind:string } | null; status?: string | null }) {
  return <NativeDesktopSession active={active}/>;
}
