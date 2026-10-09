/** Native input is authorized and executed by the installed desktop app. */
import { nativeDesktopRequest } from './nativeDesktopBridge';
import { currentComputerContext } from '../computerUse/context';
export async function hostAction(tenantId: string, command: Record<string, unknown>) {
    if (currentComputerContext()?.computerSurface === 'none') return {ok:false,error:'This task has no local screen permission.'};
    const result = await nativeDesktopRequest(command);
    return result.ok ? result : { ...result, error: `Permission denied: ${result.error ?? 'Native desktop action blocked.'}`, errorType: 'PERMISSION_DENIED' as const };
}
export const hostClick = (tenantId: string, x: number, y: number) => hostAction(tenantId, { action: 'click', x, y });
export const hostMove = (tenantId: string, x: number, y: number) => hostAction(tenantId, { action: 'move', x, y });
export const hostType = (tenantId: string, text: string) => hostAction(tenantId, { action: 'type', text });
export const hostScroll = (tenantId: string, delta: number) => hostAction(tenantId, { action: 'scroll', delta });
export const hostKey = (tenantId: string, key: string) => hostAction(tenantId, { action: 'key', key });
