import { app, BrowserWindow, ipcMain } from "electron";
import { UPDATE_IPC } from "./updateIpc";
import { UpdateService } from "./UpdateService";

export function registerUpdateIpc(service: UpdateService): void {
  ipcMain.handle(UPDATE_IPC.getState, () => service.getState());
  ipcMain.handle(UPDATE_IPC.check, () => service.check());
  ipcMain.handle(UPDATE_IPC.download, () => service.download());
  ipcMain.handle(UPDATE_IPC.restartAndInstall, (_e, raw) => service.restartAndInstall(raw));
  ipcMain.handle(UPDATE_IPC.installOnExit, () => service.installOnExit());
  ipcMain.handle(UPDATE_IPC.setChannel, (_e, raw) => service.setChannel(raw));
  ipcMain.handle(UPDATE_IPC.setAutoDownload, (_e, raw) => service.setAutoDownload(raw));
  ipcMain.handle(UPDATE_IPC.setAutoCheck, (_e, raw) => service.setAutoCheck(raw));
  ipcMain.handle(UPDATE_IPC.setInstallOnExit, (_e, raw) => service.setInstallOnExitPref(raw));
  ipcMain.handle(UPDATE_IPC.setWorkBusy, (_e, raw) => {
    service.setWorkBusy(raw === true);
    return { ok: true };
  });
  ipcMain.handle(UPDATE_IPC.dismiss, () => service.dismiss());
}

export function sendToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function createDesktopUpdateService(readConfig: () => Promise<{ backendUrl: string; apiKey: string }>): UpdateService {
  return new UpdateService({
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    getBackend: readConfig,
    send: sendToWindows,
    log: (event, detail) => console.warn(JSON.stringify({ event, ...detail })),
  });
}
