/// <reference lib="dom" />
// This isolated control strip can revoke access, never grant it or execute input.
import { ipcRenderer } from 'electron';
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('stop')?.addEventListener('click', () => void ipcRenderer.invoke('nativeDesktop:stop'));
    document.getElementById('take')?.addEventListener('click', () => void ipcRenderer.invoke('nativeDesktop:takeControl'));
    const refresh = async () => {
        try {
            const state = await ipcRenderer.invoke('nativeDesktop:status');
            const status = document.getElementById('status'), button = document.getElementById('take') as HTMLButtonElement | null;
            if (status)
                status.textContent = state.input ? 'ORION asks before each action' : "You have control / ORION can view";
            if (button)
                button.hidden = !state.input;
        }
        catch { /* main process closes the strip on revoke */ }
    };
    void refresh();
    setInterval(() => void refresh(), 500);
});
