import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import { appendFileSync, existsSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { NativeDesktopPolicy, type NativeWindow, type NativeResult } from './nativeDesktopPolicy';
export class NativeDesktop {
    private child: ChildProcessWithoutNullStreams | null = null;
    private token = '';
    private pending = new Map<string, {
        resolve: (r: NativeResult) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private timer?: ReturnType<typeof setTimeout>;
    private consentBusy = false;
    private indicator: BrowserWindow | null = null;
    private emergencyReady = false;
    private taskId: string | null = null;
    private consentGeneration = 0;
    private approvalController: AbortController | null = null;
    readonly policy = new NativeDesktopPolicy(r => this.call(r), async (window, command) => {
        const detail = command.action === 'type' ? `Type this text (${command.text!.length} characters):\n${command.text}` : command.action === 'click' || command.action === 'move' ? `${command.action} at window position ${command.x}, ${command.y}` : `${command.action} ${command.key ?? command.delta ?? ''}`;
        const controller = new AbortController();
        this.approvalController = controller;
        const timeout = setTimeout(() => controller.abort(), 60000);
        let result;
        try {
            result = await dialog.showMessageBox({ signal: controller.signal, type: 'question', title: 'Allow desktop input?', message: `Allow ORVYN to ${command.action} in ${window.title}?`, detail: `${detail}\n\nOnly the selected window is permitted. Stop: Ctrl+Alt+Shift+Escape.`, buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true });
        }
        finally {
            clearTimeout(timeout);
            if (this.approvalController === controller)
                this.approvalController = null;
        }
        return !controller.signal.aborted && result.response === 1;
    }, (action, outcome, pid) => {
        try {
            appendFileSync(path.join(app.getPath('userData'), 'native-desktop-audit.jsonl'), JSON.stringify({ time: new Date().toISOString(), action, outcome, pid }) + '\n', { mode: 0o600 });
        }
        catch { /* no content or secrets in the audit */ }
    });
    private helperPath() {return app.isPackaged ? path.join(process.resourcesPath, 'native/orvyn-native-desktop.exe') : path.resolve(__dirname, '../../resources/native/orvyn-native-desktop.exe')}
    status() { return { ...this.policy.status(), supported: process.platform === 'win32' && existsSync(this.helperPath()), stopShortcut: 'Ctrl+Alt+Shift+Escape' }; }
    stop() {
        this.taskId = null;
        this.consentGeneration++;
        this.approvalController?.abort();
        clearTimeout(this.timer);
        this.policy.stop();
        const indicator = this.indicator;
        this.indicator = null;
        indicator?.destroy();
        const child = this.child;
        this.child = null;
        child?.kill();
        this.finishPending('Desktop access stopped.');
        return this.status();
    }
    takeControl() {
        this.consentGeneration++;
        this.approvalController?.abort();
        const state = this.policy.takeControl();
        const child = this.child;
        this.child = null;
        child?.kill();
        this.finishPending('User took control; agent input cancelled.');
        return state;
    }
    resume() {
        const target = this.policy.selectedWindow();
        return target ? this.start(target.handle, true) : Promise.resolve({ ok: false, error: 'Select a window first.' });
    }
    private finishPending(error: string) {
        for (const item of this.pending.values()) {
            clearTimeout(item.timer);
            item.resolve({ ok: false, error });
        }
        this.pending.clear();
    }
    private ensure() {
        if (this.child)
            return;
        if (process.platform !== 'win32')
            throw new Error('Native desktop control currently supports Windows only.');
        this.token = randomBytes(32).toString('hex');
        const executable = this.helperPath();
        const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, ORVYN_NATIVE_TOKEN: this.token } });
        this.child = child;
        const reader = createInterface({ input: child.stdout });
        reader.on('line', line => {
            if (line.length > 12000000) {
                this.stop();
                return;
            }
            try {
                const msg = JSON.parse(line);
                const item = this.pending.get(msg.id);
                if (item) {
                    clearTimeout(item.timer);
                    this.pending.delete(msg.id);
                    item.resolve(msg.result);
                }
            }
            catch {
                this.stop();
            }
        });
        const failed = () => { if (this.child === child) {
            this.child = null;
            this.policy.stop('helper-exited');
            this.finishPending('Native helper exited.');
        } };
        child.on('error', failed);
        child.on('exit', code => {
            if(code===77 && this.child===child){this.finishPending('Run ORVYN without administrator privileges to use local desktop control.');}
            failed();
        });
        child.stdin.on('error', failed);
        // Drain diagnostics without logging screenshots or request contents.
        child.stderr.resume();
    }
    private call(request: Record<string, unknown>): Promise<NativeResult> {
        this.ensure();
        if (this.pending.size)
            return Promise.resolve({ ok: false, error: 'Native helper busy.' });
        return new Promise(resolve => {
            const id = randomBytes(16).toString('hex');
            const timer = setTimeout(() => { this.stop(); resolve({ ok: false, error: 'Native desktop request timed out.' }); }, 8000);
            this.pending.set(id, { resolve, timer });
            this.child!.stdin.write(JSON.stringify({ ...request, id, token: this.token }) + '\n');
        });
    }
    async windows() { return this.call({ action: 'windows' }); }
    async start(handle: unknown, input: unknown) {
        if (!this.emergencyReady)
            return { ok: false, error: 'The emergency stop shortcut could not be registered. Close the conflicting application and restart ORVYN.' };
        if (this.consentBusy || typeof handle !== 'string' || typeof input !== 'boolean')
            return { ok: false, error: 'Invalid or pending permission request.' };
        this.consentBusy = true;
        const generation = this.consentGeneration;
        try {
            const result = await this.windows();
            if(!result.ok)return {ok:false,error:result.error ?? "Native desktop helper unavailable."};
            const target = (result.windows as NativeWindow[] | undefined)?.find(w => w.handle === handle);
            if (!target)
                return { ok: false, error: 'The selected window is unavailable.' };
            const answer = await dialog.showMessageBox({ type: 'question', title: 'Local desktop permission', message: `Allow ORVYN to view ${target.title}?`, detail: `Application: ${target.path}\n\nAccess lasts five minutes for this window only. ${input ? 'Mouse and keyboard actions require a separate approval each time.' : 'Viewing only; mouse and keyboard are blocked.'}\nScreenshots and UI details may be sent to your selected AI provider. No file-system or shell permission is granted.\nStop any time: Ctrl+Alt+Shift+Escape.`, buttons: ['Cancel', 'Allow for five minutes'], defaultId: 0, cancelId: 0, noLink: true });
            if (answer.response !== 1 || generation !== this.consentGeneration)
                return { ok: false, error: 'Permission was not granted.' };
            clearTimeout(this.timer);
            this.taskId = null;
            const status = this.policy.start(target, input);
            this.timer = setTimeout(() => this.stop(), 5 * 60000);
            this.showIndicator();
            return { ok: true, ...status };
        }
        catch {
            return { ok: false, error: 'Native desktop helper unavailable.' };
        }
        finally {
            this.consentBusy = false;
        }
    }
    request(command: unknown): Promise<NativeResult> {
        const c = command as {action?:string;runId?:string} | null;
        if (c?.action === 'status') return Promise.resolve({ok:true,...this.status()});
        if (!c?.runId || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.runId)) return Promise.resolve({ok:false,error:'Native access requires an active task.'});
        if (c.action === 'end_task') { if (this.taskId === c.runId) {this.taskId=null;this.approvalController?.abort();this.policy.endTask();const child=this.child;this.child=null;child?.kill();this.finishPending('Task ended; pending desktop action cancelled.');} return Promise.resolve({ok:true}); }
        if (this.taskId && this.taskId !== c.runId) return Promise.resolve({ok:false,error:'Another task owns this window session.'});
        if (!this.policy.status().active) return Promise.resolve({ok:false,error:'Choose an app window and allow local sharing first.'});
        this.taskId = c.runId;
        return this.policy.request(command);
    }
    bindWindow(window: BrowserWindow) {
        window.webContents.on('did-start-navigation', (_e, _url, _inPlace, main) => { if (main)
            this.stop(); });
        window.on('closed', () => this.stop());
    }
    private showIndicator() {
        if (this.indicator && !this.indicator.isDestroyed())
            return;
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const indicator = new BrowserWindow({ title: 'ORVYN desktop access', x: area.x + Math.max(0, area.width - 456), y: area.y + Math.max(0, area.height - 132), width: 440, height: 116, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, backgroundColor: '#141b29', webPreferences: { preload: path.join(__dirname, '../preload/nativeDesktopIndicator.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
        this.indicator = indicator;
        indicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        indicator.webContents.on('will-navigate', event => event.preventDefault());
        indicator.on('closed', () => { if (this.indicator === indicator) {
            this.indicator = null;
            this.stop();
        } });
        indicator.once('ready-to-show', () => indicator.showInactive());
        void indicator.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}body{margin:0;padding:12px 16px;background:linear-gradient(115deg,#302045,#142f40);color:#eef0ff;font:12px system-ui;border:1px solid #7660a5;border-radius:12px}header{-webkit-app-region:drag;display:flex;gap:8px;align-items:center;margin-bottom:10px}b{color:#8de3f3;font-size:11px;letter-spacing:.08em}#status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}button{font:inherit;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #8d78d4;color:#fff;background:#6045a0;margin-right:6px}button:focus-visible{outline:2px solid #80e0f2}#stop{background:#43243c;border-color:#8a536d;color:#ffd0dc}.hint{display:block;margin-top:7px;color:#bdc5e2;font-size:10px}</style></head><body><header><b>ORVYN</b><span id="status">App sharing active</span></header><button id="take">Take Control</button><button id="stop">Stop sharing</button><span class="hint">Drag this bar to move it / Emergency stop: Ctrl+Alt+Shift+Esc</span></body></html>`));
    }
    register(getWindow: () => BrowserWindow | null) {
        const trusted = (event: Electron.IpcMainInvokeEvent) => event.sender === getWindow()?.webContents && event.senderFrame === getWindow()?.webContents.mainFrame;
        const handlers: Record<string, (a?: unknown, b?: unknown) => unknown> = { status: () => this.status(), windows: () => this.windows(), start: (h, i) => this.start(h, i), preview: () => this.policy.request({ action: "screenshot" }, false), stop: () => this.stop(), takeControl: () => this.takeControl(), resume: () => this.resume() };
        for (const [name, handler] of Object.entries(handlers))
            ipcMain.handle(`nativeDesktop:${name}`, (event, ...args) => {
                const indicatorSender = event.sender === this.indicator?.webContents && event.senderFrame === this.indicator?.webContents.mainFrame;
                if (!trusted(event) && !(indicatorSender && ['status', 'stop', 'takeControl'].includes(name)))
                    throw new Error('Untrusted desktop permission request.');
                return handler(args[0], args[1]);
            });
        this.emergencyReady = globalShortcut.register('CommandOrControl+Alt+Shift+Escape', () => this.stop());
    }
}
export const nativeDesktop = new NativeDesktop();
