export interface NativeWindow {
    handle: string;
    pid: number;
    started: string;
    path: string;
    title: string;
}
export interface DesktopCommand {
    action: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    delta?: number;
}
export interface NativeResult {
    ok: boolean;
    output?: string;
    error?: string;
    [key: string]: unknown;
}
const reads = new Set(['screenshot', 'inspect']);
const inputs = new Set(['focus', 'click', 'move', 'type', 'scroll', 'key']);
/** Local authority. An agent may request an action but can never create a grant. */
export class NativeDesktopPolicy {
    private grant: {
        window: NativeWindow;
        expiresAt: number;
        input: boolean;
    } | null = null;
    private generation = 0;
    private busy = false;
    private frameGeneration = -1;
    private execute: (request: Record<string, unknown>) => Promise<NativeResult>;
    private approve: (window: NativeWindow, command: DesktopCommand) => Promise<boolean>;
    private audit: (action: string, outcome: string, pid?: number) => void;
    private now: () => number;
    constructor(execute: (request: Record<string, unknown>) => Promise<NativeResult>, approve: (window: NativeWindow, command: DesktopCommand) => Promise<boolean>, audit: (action: string, outcome: string, pid?: number) => void, now = Date.now) { this.execute = execute; this.approve = approve; this.audit = audit; this.now = now; }
    selectedWindow() { this.status(); return this.grant ? { ...this.grant.window } : null; }
    takeControl() {
        this.generation++;
        this.status();
        if (this.grant) {
            this.grant.input = false;
            this.audit('session', 'user-took-control', this.grant.window.pid);
        }
        return this.status();
    }
    status() {
        if (this.grant && this.grant.expiresAt <= this.now())
            this.stop('expired');
        return { active: Boolean(this.grant), window: this.grant?.window.title, expiresAt: this.grant?.expiresAt, input: this.grant?.input ?? false, busy: this.busy };
    }
    // Called only by the trusted main-process consent flow, never child IPC.
    start(window: NativeWindow, input: boolean) {
        this.stop('replaced');
        this.grant = { window: { ...window }, input, expiresAt: this.now() + 5 * 60000 };
        this.audit('session', 'granted', window.pid);
        return this.status();
    }
    stop(reason = 'stopped') {
        this.generation++;
        if (this.grant)
            this.audit('session', reason, this.grant.window.pid);
        this.grant = null;
        return this.status();
    }
    async request(value: unknown, observe = true): Promise<NativeResult> {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return { ok: false, error: 'Invalid desktop request.' };
        const c = value as DesktopCommand;
        if (c.action === 'status')
            return { ok: true, output: JSON.stringify(this.status()) };
        const isInput = inputs.has(c.action);
        if (!reads.has(c.action) && !isInput)
            return { ok: false, error: 'Unsupported native desktop action.' };
        this.status();
        const grant = this.grant, generation = this.generation;
        if (!grant || (isInput && !grant.input))
            return { ok: false, error: 'Select a window and grant local desktop access in Settings > Cloud & Execution.' };
        if (isInput && c.action !== 'focus' && this.frameGeneration !== generation)
            return { ok: false, error: 'Read a fresh screenshot of the approved window before sending input.' };
        if (this.busy)
            return { ok: false, error: 'A desktop action is already pending. Do not retry automatically.' };
        if (['click', 'move'].includes(c.action) && (!Number.isInteger(c.x) || !Number.isInteger(c.y)))
            return { ok: false, error: 'Window coordinates must be integers.' };
        if (c.action === 'type' && (typeof c.text !== 'string' || c.text.length > 1000))
            return { ok: false, error: 'Text must contain at most 1000 characters.' };
        if (c.action === 'scroll' && (!Number.isInteger(c.delta) || Math.abs(c.delta!) > 1200))
            return { ok: false, error: 'Invalid scroll amount.' };
        if (c.action === 'key' && !['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'].includes(c.key!))
            return { ok: false, error: 'System shortcuts are blocked.' };
        this.busy = true;
        try {
            if (isInput && !await this.approve(grant.window, c)) {
                this.audit(c.action, 'denied', grant.window.pid);
                return { ok: false, error: 'User declined input. Do not retry.' };
            }
            if (generation !== this.generation || grant.expiresAt <= this.now())
                return { ok: false, error: 'Desktop permission was stopped or expired.' };
            // Pick fields explicitly: requests cannot replace the target, grant or expiry.
            const result = await this.execute({ ...grant.window, expiresAt: grant.expiresAt, action: c.action, x: c.x, y: c.y, text: c.text, key: c.key, delta: c.delta });
            if (generation !== this.generation)
                return { ok: false, error: 'Desktop access was revoked.' };
            if (result.ok && c.action === 'screenshot' && observe)
                this.frameGeneration = generation;
            this.audit(c.action, result.ok ? 'completed' : 'failed', grant.window.pid);
            return result;
        }
        catch {
            if (generation !== this.generation)
                return { ok: false, error: 'Desktop access changed; action cancelled.' };
            this.stop('helper-failed');
            return { ok: false, error: 'Native helper unavailable. Desktop access stopped.' };
        }
        finally {
            this.busy = false;
        }
    }
}
