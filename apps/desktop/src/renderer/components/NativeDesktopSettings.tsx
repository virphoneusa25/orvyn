import React, { useEffect, useState } from 'react';
import './nativeDesktop.css';
export function NativeDesktopSettings({ onStarted }: { onStarted?: () => void } = {}) {
    const bridge = window.orvyn?.nativeDesktop;
    const [supported, setSupported] = useState(false);
    const [windows, setWindows] = useState<Array<{
        handle: string;
        title: string;
        path: string;
    }>>([]);
    const [selected, setSelected] = useState('');
    const [input, setInput] = useState(false);
    const [detail, setDetail] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { void bridge?.status().then(s => setSupported(s.supported)); }, []);
    async function refresh() {
        try {
            const result = await bridge?.windows();
            setWindows(result?.windows ?? []);
            setSelected(current => result?.windows?.some(w => w.handle === current) ? current : '');
            setDetail(result?.error ?? 'Choose the window you want ORVYN to use.');
        }
        catch {
            setDetail('Native helper unavailable.');
        }
    }
    async function start() {
        setBusy(true);
        try {
            const result = await bridge?.start(selected, input);
            if (result?.ok) onStarted?.();
            setDetail(result?.ok ? 'Access granted for five minutes. Stop at any time with Ctrl+Alt+Shift+Escape.' : result?.error ?? 'Desktop application required.');
        }
        catch {
            setDetail('Could not start desktop access.');
        }
        finally {
            setBusy(false);
        }
    }
    return <section className="native-desktop nd-setup" aria-label="Local desktop permissions">
    <span className="nd-eyebrow">This computer / private by default</span>
    <h3>Share an app with ORION</h3>
    <p className="nd-muted">Choose one window. You can keep working in that app while ORION sees it and helps with your task.</p>
    {!supported ? <p className="nd-note">Available in the Windows desktop app. No access is enabled on this device.</p> : <>
      <label className="nd-step" htmlFor="native-window">1. Choose an open app</label>
      <button type="button" onClick={() => void refresh()}>Find open windows</button>
      <select id="native-window" aria-label="Application window" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Select a window to share</option>
        {windows.map(w => <option key={w.handle} value={w.handle}>{w.title}</option>)}
      </select>
      <span className="nd-step">2. Choose how ORION can help</span>
      <div className="nd-choice"><span aria-hidden="true">&#9673;</span><span>View the selected window<small>You keep control of your mouse and keyboard.</small></span></div>
      <label className="nd-choice"><input type="checkbox" checked={input} onChange={e => setInput(e.target.checked)}/><span>Also allow approved clicks and typing<small>ORION must ask before each action. Take Control pauses those requests while viewing continues.</small></span></label>
      <span className="nd-step">3. Start a five-minute session</span>
      <button className="nd-primary" type="button" disabled={!selected || busy} onClick={() => void start()}>{busy ? 'Waiting for permission...' : 'Start sharing...'}</button>
      <p className="nd-muted">A permission dialog opens before sharing starts. Starting a session does not start an AI task: tell ORION what you need in chat.</p>
    </>}
    {detail && <p className="nd-note" role="status">{detail}</p>}
    <details className="nd-muted"><summary>Privacy and safety</summary><p>Access ends after five minutes. Stop sharing ends viewing and input immediately. Emergency stop: Ctrl+Alt+Shift+Escape.</p><p>Screenshots and UI details may be sent to your selected AI provider when ORION assists. Local preview refreshes do not use AI credits. File access, terminal control and administrator access are not granted.</p></details>
  </section>;
}
