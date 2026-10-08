import { randomUUID } from 'crypto';
export interface NativeDesktopResult {
    ok: boolean;
    output?: string;
    error?: string;
    screenshot?: {
        b64: string;
        mediaType: string;
    };
    [key: string]: unknown;
}
const pending = new Map<string, {
    resolve: (r: NativeDesktopResult) => void;
    timer: ReturnType<typeof setTimeout>;
}>();
process.on('message', (message: any) => {
    if (message?.type !== 'desktop.result')
        return;
    const item = pending.get(message.id);
    if (item) {
        clearTimeout(item.timer);
        pending.delete(message.id);
        item.resolve(message.result);
    }
});
process.on('disconnect', () => {
    for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve({ ok: false, error: 'Desktop application disconnected.' });
    }
    pending.clear();
});
/** Only Electron-owned children have this private inherited IPC channel. Never shell out on a server. */
export function nativeDesktopRequest(command: unknown): Promise<NativeDesktopResult> {
    if (typeof process.send !== 'function' || !process.connected)
        return Promise.resolve({ ok: false, error: 'Use the installed ORVYN desktop application and grant local window access. Native controls are unavailable on this server.' });
    if (pending.size)
        return Promise.resolve({ ok: false, error: 'A native desktop action is pending. Do not retry.' });
    return new Promise(resolve => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'Desktop approval timed out. Do not retry automatically.' }); }, 120000);
        pending.set(id, { resolve, timer });
        process.send!({ type: 'desktop.command', id, command }, error => {
            if (error) {
                clearTimeout(timer);
                pending.delete(id);
                resolve({ ok: false, error: 'Desktop IPC unavailable.' });
            }
        });
    });
}
