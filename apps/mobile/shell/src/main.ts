import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MobilePlatform } from "../../../web/src/lib/mobilePlatform";
import { validatedMobileOrigin } from "../../../web/src/lib/mobilePlatform";

declare const __ORVYN_API_ORIGIN__: string;

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("The file could not be prepared for saving."));
    reader.readAsDataURL(blob);
  });
}
function fileName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 160) || "orvyn-file";
}
if (Capacitor.isNativePlatform()) {
  const apiOrigin = validatedMobileOrigin(__ORVYN_API_ORIGIN__);
  const mobile: MobilePlatform = {
    apiOrigin,
    openBrowser: (url) => Browser.open({ url }),
    closeBrowser: () => Browser.close(),
    saveFile: async (blob, name) => {
      const path = `orvyn-exports/${crypto.randomUUID()}/${fileName(name)}`;
      const file = await Filesystem.writeFile({ path, data: await readBase64(blob), directory: Directory.Cache, recursive: true });
      try { await Share.share({ title: name, files: [file.uri], dialogTitle: "Save or share your ORVYN file" }); }
      catch (error) { await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined); throw error; }
      // Keep successfully shared files in OS-managed cache while the recipient reads them.
    },
  };
  window.orvynMobile = mobile;
  await App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) window.dispatchEvent(new Event("focus"));
  });
  await App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) history.back();
    else void App.minimizeApp();
  });
}
// Set up the native bridge before the unchanged portal mounts or makes requests.
await import("../../../web/src/main");
