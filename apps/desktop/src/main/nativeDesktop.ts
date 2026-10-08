import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import { appendFileSync } from 'fs';
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
    status() { return { ...this.policy.status(), supported: process.platform === 'win32', stopShortcut: 'Ctrl+Alt+Shift+Escape' }; }
    stop() {
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
        const executable = app.isPackaged ? path.join(process.resourcesPath, 'native/orvyn-native-desktop.exe') : path.resolve(__dirname, '../../resources/native/orvyn-native-desktop.exe');
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
    request(command: unknown) { return this.policy.request(command); }
    bindWindow(window: BrowserWindow) {
        window.webContents.on('did-start-navigation', (_e, _url, _inPlace, main) => { if (main)
            this.stop(); });
        window.on('closed', () => this.stop());
    }
    private showIndicator() {
        if (this.indicator && !this.indicator.isDestroyed())
            return;
        const indicator = new BrowserWindow({ title: 'ORVYN desktop access', width: 540, height: 100, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, backgroundColor: '#141b29', webPreferences: { preload: path.join(__dirname, '../preload/nativeDesktopIndicator.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
        this.indicator = indicator;
        indicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        indicator.webContents.on('will-navigate', event => event.preventDefault());
        indicator.on('closed', () => { if (this.indicator === indicator) {
            this.indicator = null;
            this.stop();
        } });
        indicator.once('ready-to-show', () => indicator.showInactive());
        void indicator.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;padding:12px;background:#141b29;color:white;font:13px system-ui}header{-webkit-app-region:drag;margin-bottom:8px}button{margin-right:8px;padding:6px;cursor:pointer}#status{font-weight:600}</style></head><body><header id="status">ORVYN desktop access</header><button id="take">Take Control</button><button id="stop">Stop viewing and control</button><span>Ctrl+Alt+Shift+Esc</span></body></html>`));
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
