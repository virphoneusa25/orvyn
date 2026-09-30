import { useEffect } from "react";

// Tiny app-wide signals so separate parts of the portal stay in sync
// (a chat created in Chats shows up in the sidebar at once).

type Name = "sessions" | "projects" | "files" | "notifications";
const subs = new Map<Name, Set<() => void>>();

export function signal(name: Name): void {
  subs.get(name)?.forEach((fn) => { try { fn(); } catch { /* a listener never breaks another */ } });
}

export function useSignal(name: Name, fn: () => void): void {
  useEffect(() => {
    let set = subs.get(name);
    if (!set) { set = new Set(); subs.set(name, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }, [name, fn]);
}
