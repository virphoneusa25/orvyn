import React, { useEffect, useState } from 'react';
export function HostDesktopBanner() {
    const [state, setState] = useState<{
        active: boolean;
        window?: string;
        expiresAt?: number;
        input: boolean;
    } | null>(null);
    useEffect(() => {
        let alive = true;
        const load = () => { void window.orvyn?.nativeDesktop?.status().then(s => { if (alive)
            setState(s); }).catch(() => { if (alive)
            setState(null); }); };
        load();
        const timer = setInterval(load, 500);
        return () => { alive = false; clearInterval(timer); };
    }, []);
    if (!state?.active)
        return null;
    return <div role="status" style={{ padding: '8px 12px', background: '#473218', display: 'flex', gap: 12, alignItems: 'center' }}>
    <strong>Local desktop access: {state.window}</strong>
    <span>{state.input ? 'Agent inputs require approval' : 'You have control; ORVYN can view and assist'} | {Math.max(0, Math.ceil(((state.expiresAt ?? 0) - Date.now()) / 60000))} min left</span>
    {state.input ? <button type="button" onClick={() => { void window.orvyn?.nativeDesktop?.takeControl(); setState({ ...state, input: false }); }}>Take control</button> : <button type="button" onClick={() => void window.orvyn?.nativeDesktop?.resume()}>Return control to ORVYN...</button>}
    <button type="button" onClick={() => { void window.orvyn?.nativeDesktop?.stop(); setState(null); }}>Stop viewing and control</button>
    <span>Ctrl+Alt+Shift+Escape</span>
  </div>;
}
