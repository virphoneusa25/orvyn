
// Thin-line icons (one stroke weight), drawn for the portal.
const I = ({ d, size = 22, fill, children }: { d?: string; size?: number; fill?: boolean; children?: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d ? <path d={d} /> : children}
  </svg>
);

export const Icon = {
  home: (p: { size?: number }) => <I {...p} d="M3 11.5 12 4l9 7.5M5.5 9.8V20h13V9.8M10 20v-5.5h4V20" />,
  chat: (p: { size?: number }) => <I {...p} d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4A8 8 0 1 1 20 12zM8.5 11h.01M12 11h.01M15.5 11h.01" />,
  folder: (p: { size?: number }) => <I {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: (p: { size?: number }) => <I {...p} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6" />,
  usage: (p: { size?: number }) => <I {...p} d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  billing: (p: { size?: number }) => <I {...p} d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4" />,
  settings: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></I>,
  help: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></I>,
  download: (p: { size?: number }) => <I {...p} d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  upload: (p: { size?: number }) => <I {...p} d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  search: (p: { size?: number }) => <I {...p} d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2" />,
  bell: (p: { size?: number }) => <I {...p} d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />,
  chev: (p: { size?: number }) => <I {...p} d="M9 6l6 6-6 6" />,
  down: (p: { size?: number }) => <I {...p} d="M6 9l6 6 6-6" />,
  plus: (p: { size?: number }) => <I {...p} d="M12 5v14M5 12h14" />,
  check: (p: { size?: number }) => <I {...p} d="M5 12.5l4.5 4.5L19 7.5" />,
  x: (p: { size?: number }) => <I {...p} d="M6 6l12 12M18 6L6 18" />,
  layers: (p: { size?: number }) => <I {...p} d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />,
  coins: (p: { size?: number }) => <I {...p}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></I>,
  clock: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>,
  bars: (p: { size?: number }) => <I {...p} d="M5 20v-6M10 20V9M15 20v-9M20 20V5" />,
  plusCircle: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></I>,
  crown: (p: { size?: number }) => <I {...p} d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5zM5 19h14" />,
  info: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></I>,
  spark: (p: { size?: number }) => <I {...p} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
  paperclip: (p: { size?: number }) => <I {...p} d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />,
  send: (p: { size?: number }) => <I {...p} d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />,
  more: (p: { size?: number }) => <I {...p}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></I>,
  user: (p: { size?: number }) => <I {...p} d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
  eye: (p: { size?: number }) => <I {...p} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />,
  copy: (p: { size?: number }) => <I {...p} d="M9 9h11v11H9zM5 15H4V4h11v1" />,
  trash: (p: { size?: number }) => <I {...p} d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  code: (p: { size?: number }) => <I {...p} d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
  chart: (p: { size?: number }) => <I {...p} d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6" />,
  monitor: (p: { size?: number }) => <I {...p} d="M3 4h18v12H3zM8 20h8M12 16v4" />,
  shield: (p: { size?: number }) => <I {...p} d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  logout: (p: { size?: number }) => <I {...p} d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />,
  pin: (p: { size?: number }) => <I {...p} d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6" />,
  share: (p: { size?: number }) => <I {...p} d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v12M8 7l4-4 4 4" />,
  edit: (p: { size?: number }) => <I {...p} d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  retry: (p: { size?: number }) => <I {...p} d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />,
  grid: (p: { size?: number }) => <I {...p} d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  listIcon: (p: { size?: number }) => <I {...p} d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  users: (p: { size?: number }) => <I {...p} d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7M18 14a6 6 0 0 1 4 7" />,
  key: (p: { size?: number }) => <I {...p} d="M15 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM13.8 11.8L21 19v2h-3v-2h-2v-2h-2l-1.3-1.3" />,
  link: (p: { size?: number }) => <I {...p} d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  stop: (p: { size?: number }) => <I {...p} fill><rect x="6" y="6" width="12" height="12" rx="2" /></I>,
  arrowUp: (p: { size?: number }) => <I {...p} d="M12 19V5M5 12l7-7 7 7" />,
  back: (p: { size?: number }) => <I {...p} d="M15 6l-6 6 6 6" />,
  plug: (p: { size?: number }) => <I {...p} d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  bolt: (p: { size?: number }) => <I {...p} d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  globe: (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></I>,
  mail: (p: { size?: number }) => <I {...p} d="M3 6h18v12H3zM3 7l9 6 9-6" />,
  lock: (p: { size?: number }) => <I {...p} d="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4" />,
  image: (p: { size?: number }) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></I>,
  pen: (p: { size?: number }) => <I {...p} d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  book: (p: { size?: number }) => <I {...p} d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M19 17H6a2 2 0 0 0-2 2" />,
  google: () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.1 14.7 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7z" /></svg>,
  github: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" /></svg>,
};

/** A small gradient folder (Recent Projects). */
export function FolderGlyph({ hue = 0 }: { hue?: number }) {
  const palettes = [["#a78bfa", "#7c3aed"], ["#60a5fa", "#2563eb"], ["#f472b6", "#db2777"], ["#5eead4", "#0d9488"]];
  const [a, b] = palettes[hue % palettes.length]!;
  const id = `fg${hue}`;
  return (
    <svg className="folder" viewBox="0 0 30 26" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient></defs>
      <path d="M2 5a3 3 0 0 1 3-3h6l3 3h11a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill={`url(#${id})`} />
      <path d="M2 10h26" stroke="rgba(255,255,255,.25)" />
    </svg>
  );
}
