// Production cloud CORS. Electron's renderer is file:// (Origin null) and
// must stay allowed. Arbitrary browser origins are not reflected when
// ORVYN_CLOUD_MODE=true. Local development leaves the check open so the
// Vite dev server can call the backend.

import cors from "cors";
import { cloudModeEnabled } from "../middleware/tenant";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function originAllowed(origin: string | undefined, cloud: boolean, publicUrl?: string): boolean {
  if (!cloud) return true;
  if (origin == null || origin === "" || origin === "null") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return true;
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) return true;
  if (publicUrl) {
    try {
      const pub = new URL(publicUrl);
      if (url.host === pub.host) return true;
    } catch {
      /* ignore a bad public URL */
    }
  }
  return false;
}

export function cloudCors() {
  return cors({
    origin(origin, callback) {
      const ok = originAllowed(origin, cloudModeEnabled(), process.env.ORVYN_PUBLIC_URL);
      callback(null, ok);
    },
  });
}
