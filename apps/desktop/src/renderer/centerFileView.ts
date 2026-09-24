// apps/desktop/src/renderer/centerFileView.ts
//
// Clicking a file in the Files tab shows it in the CENTER of the window, in
// place of the conversation, instead of in a small box under the file list.
// The Files tab owns what is shown (it already knows how to read local and
// Cloud files); App owns the center area. This tiny store connects the two:
// App registers the center element, the Files tab asks for it to be shown and
// renders the file into it.

import { useSyncExternalStore } from "react";

type Listener = () => void;

let host: HTMLElement | null = null;
let open = false;
let version = 0;
const listeners = new Set<Listener>();

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

export const centerFileView = {
  isOpen: () => open,
  getHost: () => host,
  /** Ref callback for the center element App renders while a file is shown. */
  setHost(el: HTMLElement | null) {
    if (host === el) return;
    host = el;
    emit();
  },
  open() {
    if (open) return;
    open = true;
    emit();
  },
  close() {
    if (!open) return;
    open = false;
    emit();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

export function useCenterFileView(): { open: boolean; host: HTMLElement | null } {
  useSyncExternalStore(centerFileView.subscribe, () => version);
  return { open, host };
}
