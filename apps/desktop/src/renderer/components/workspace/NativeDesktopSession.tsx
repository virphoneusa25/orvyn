import React, { useEffect, useRef, useState } from 'react';
import { NativeDesktopSettings } from '../NativeDesktopSettings';
type State = {
    active: boolean;
    input: boolean;
    window?: string;
    expiresAt?: number;
};
/** Preview refreshes stay local. They never start an AI run or spend provider credits. */
export function NativeDesktopSession({ active }: {
    active: boolean;
}) {
    const bridge = window.orvyn?.nativeDesktop;
    const [state, setState] = useState<State | null>(null);
    const [frame, setFrame] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let alive = true, busy = false;
        async function refresh() {
            if (!active || busy || document.hidden || !bridge)
                return;
            busy = true;
            try {
                const status = await bridge.status();
                if (!alive)
                    return;
                setState(status);
                if (!status.active) {
                    setFrame(null);
                    return;
                }
                const result = await bridge.preview();
                if (!alive)
                    return;
                if (result.ok && result.screenshot) {
                    setFrame(`data:${result.screenshot.mediaType};base64,${result.screenshot.b64}`);
                    setNote('');
                }
                else if (!/pending|busy/i.test(result.error ?? '')) {
                    setFrame(null);
                    setNote(result.error ?? 'No window picture available.');
                }
            }
            catch {
                if (alive) {
                    setFrame(null);
                    setNote('Desktop helper unavailable.');
                }
            }
            finally {
                busy = false;
            }
        }
        void refresh();
        const timer = setInterval(() => void refresh(), 1500);
        return () => { alive = false; clearInterval(timer); setFrame(null); };
    }, [active]);
    async function takeover() { await bridge?.takeControl(); setState(s => s ? { ...s, input: false } : s); }
    async function resume() {
        setFrame(null);
        const result = await bridge?.resume();
        if (result?.ok) {
            setState(s => s ? { ...s, input: true } : s);
            setNote('ORVYN will read a fresh view before continuing.');
        }
        else
            setNote(result?.error ?? 'Desktop application required.');
    }
    async function stop() { setFrame(null); setState(null); await bridge?.stop(); }
    async function screenshot() {
        const result = await bridge?.preview();
        if (!result?.ok || !result.screenshot) {
            setNote(result?.error ?? 'No screenshot available.');
            return;
        }
        const anchor = document.createElement('a');
        anchor.href = `data:image/png;base64,${result.screenshot.b64}`;
        anchor.download = `ORVYN-local-window-${Date.now()}.png`;
        anchor.click();
    }
    return <div ref={root} className="native-desktop nd-session">
    <header className="nd-session-header">
      <div><span className="nd-eyebrow">This computer</span><h3>{state?.active ? 'Shared app' : 'Work together on your desktop'}</h3><p className="nd-muted">One selected window. Your control, at any time.</p></div>
      {state?.active && <div className="nd-actions"><button className="nd-primary" type="button" onClick={() => void (state.input ? takeover() : resume())}>{state.input ? 'Take Control' : 'Allow ORION actions...'}</button><button className="nd-stop" type="button" onClick={() => void stop()}>Stop sharing</button></div>}
    </header>
    {!state?.active && <div style={{ padding: 16 }}><NativeDesktopSettings /></div>}
    {state?.active && <>
      <div role="status" className="nd-status">
        <strong>{state.input ? 'ORION asks before every action' : "You're in control"}</strong>
        <div className="nd-window" title={state.window}>{state.window}</div>
        <span className="nd-muted">{state.input ? 'Take Control to pause clicks and typing.' : 'Work in the actual app. ORION can view and assist.'} {Math.max(0, Math.ceil(((state.expiresAt ?? 0) - Date.now()) / 60000))} min left</span>
      </div>
      <div className="nd-frame">
        {frame ? <img src={frame} alt="Live view of the locally approved application window"/> : <p className="nd-muted">{note || 'Connecting to your selected window...'}</p>}
      </div>
      <footer className="nd-footer">
        <div className="nd-actions"><button type="button" onClick={() => void screenshot()}>Save screenshot</button><button type="button" onClick={() => void root.current?.requestFullscreen().catch(() => undefined)}>Full screen</button></div>
        <p className="nd-muted">This is a preview. Use the app itself to click or type. Tell ORION your task in chat; sharing alone does not start work.</p>
        <p className="nd-muted">Preview refreshes are local and use no AI credits. Emergency stop: Ctrl+Alt+Shift+Escape.</p>
      </footer>
    </>}
    {note && <p role="status" className="nd-note" style={{ margin: 12 }}>{note}</p>}
  </div>;
}
