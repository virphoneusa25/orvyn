import React, { useEffect, useState } from 'react';
export function NativeDesktopSettings() {
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
            setDetail(result?.ok ? 'Access granted for five minutes. Stop at any time with Ctrl+Alt+Shift+Escape.' : result?.error ?? 'Desktop application required.');
        }
        catch {
            setDetail('Could not start desktop access.');
        }
        finally {
            setBusy(false);
        }
    }
    return <section style={{ marginTop: 28 }} aria-label="Local desktop permissions">
    <h3>Local desktop permissions</h3>
    <p>Off until you allow access. Select one open application window for five minutes. Mouse and keyboard actions ask for approval each time. Take Control keeps viewing available while you work. Stop revokes viewing and input. Screenshots may be shared with your selected AI provider.</p>
    {!supported ? <p>Native desktop control currently supports Windows. Other platforms stay disabled.</p> : <>
      <button type="button" onClick={() => void refresh()}>Choose an open window</button>{' '}
      <select aria-label="Application window" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Select a window</option>
        {windows.map(w => <option key={w.handle} value={w.handle}>{w.title}</option>)}
      </select>
      {selected && <p style={{ fontSize: 12 }}>{windows.find(w => w.handle === selected)?.path}</p>}
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={input} onChange={e => setInput(e.target.checked)}/> Allow mouse and keyboard requests, with approval for each action</label>
      <button type="button" disabled={!selected || busy} onClick={() => void start()}>Allow selected window...</button>{' '}
      <button type="button" onClick={() => { void bridge?.stop(); setDetail('Desktop access stopped.'); }}>Stop desktop access</button>
    </>}
    {detail && <p role="status">{detail}</p>}
    <p style={{ fontSize: 12 }}>No administrator access or terminal control. This permission does not grant file access. Windows security restrictions still apply.</p>
  </section>;
}
