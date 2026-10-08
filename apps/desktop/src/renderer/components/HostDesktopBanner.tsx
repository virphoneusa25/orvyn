import React, { useEffect, useState } from 'react';
import './nativeDesktop.css';
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
    return <div role="status" className="native-desktop nd-banner">
    <strong>{state.input ? 'App sharing / ORION asks first' : 'App sharing / You have control'}</strong>
    <span className="nd-window" title={state.window}>{state.window}</span>
    <span className="nd-muted">{Math.max(0, Math.ceil(((state.expiresAt ?? 0) - Date.now()) / 60000))} min left</span>
    {state.input && <button type="button" onClick={() => { void window.orvyn?.nativeDesktop?.takeControl(); setState({ ...state, input: false }); }}>Take Control</button>}
    <button className="nd-stop" type="button" onClick={() => { void window.orvyn?.nativeDesktop?.stop(); setState(null); }}>Stop sharing</button>
  </div>;
}
