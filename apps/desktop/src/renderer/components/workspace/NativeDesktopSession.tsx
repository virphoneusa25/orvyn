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
    const [settings, setSettings] = useState(false);
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
    return <div ref={root} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--orvyn-bg)', overflow: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderBottom: '1px solid var(--orvyn-border)', flexWrap: 'wrap' }}>
      <strong>Live Desktop Session</strong><span>Connection: This computer</span>
      {state?.active && <><button type="button" onClick={() => void (state.input ? takeover() : resume())}>{state.input ? 'Take Control' : 'Return to ORION'}</button><button type="button" onClick={() => void stop()}>Stop Session</button></>}
      <button type="button" onClick={() => setSettings(s => !s)}>Window permissions</button>
    </header>
    {(!state?.active || settings) && <div style={{ padding: 16 }}><NativeDesktopSettings /></div>}
    {state?.active && <>
      <div role="status" style={{ padding: '8px 12px', background: state.input ? '#24354a' : '#473218' }}>
        <strong>{state.input ? 'ORION can request control' : "You're in control"}</strong> · {state.window} · {state.input ? 'Every input asks first' : 'ORION can view and assist while you work'}
      </div>
      <div style={{ flex: 1, minHeight: 220, display: 'grid', placeItems: 'center', overflow: 'hidden', background: '#080c14' }}>
        {frame ? <img src={frame} alt="Live view of the locally approved application window" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}/> : <p>{note || 'Waiting for the selected window...'}</p>}
      </div>
      <footer style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Windows · Selected window only</span>
        <button type="button" onClick={() => void screenshot()}>Screenshot</button>
        <button type="button" onClick={() => void root.current?.requestFullscreen().catch(() => undefined)}>Full Screen</button>
        <span>Stop: Ctrl+Alt+Shift+Escape</span>
      </footer>
      <p style={{ margin: '0 12px 12px', fontSize: 12 }}>Use the actual application to work while ORION assists. Preview refreshes stay local and do not use AI credits.</p>
    </>}
    {note && <p role="status" style={{ padding: 12 }}>{note}</p>}
  </div>;
}
