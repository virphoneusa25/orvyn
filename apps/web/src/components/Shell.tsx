import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { adminUrl } from "../lib/surface";
import { navigate, useLocation } from "../lib/router";
import { num } from "../lib/format";
import { Icon } from "./Icons";
import { Orb } from "./Orb";
import { ModelPicker } from "./ModelPicker";
import icon from "../assets/icon.png";

const NAV: { to: string; label: string; icon: keyof typeof Icon; chev?: boolean }[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/chats", label: "Chats", icon: "chat", chev: true },
  { to: "/projects", label: "Projects", icon: "folder" },
  { to: "/files", label: "Files", icon: "file" },
  { to: "/usage", label: "Usage", icon: "usage" },
  { to: "/billing", label: "Billing", icon: "billing" },
  { to: "/settings", label: "Settings", icon: "settings" },
  { to: "/help", label: "Help", icon: "help" },
];

function active(path: string, to: string): boolean {
  if (to === "/") return path === "/" || path === "/home";
  return path === to || path.startsWith(`${to}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { path } = useLocation();
  const full = path.startsWith("/chats");
  return (
    <div className="app">
      <Sidebar path={path} />
      <div className="main">
        <TopBar />
        <main className={`content${full ? " content--full" : ""}`}>{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ path }: { path: string }) {
  const { billing } = useStore();
  const planId = billing?.wallet.plan.id ?? "free";
  const showUpsell = planId === "free" || planId === "starter";
  return (
    <aside className="side">
      <button className="brand" onClick={() => navigate("/")} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", textAlign: "left" }} aria-label="ORVYN Cloud home">
        <span className="brand__mark"><Orb /></span>
        <span>
          <div className="brand__word">ORVYN</div>
          <div className="brand__sub">CLOUD</div>
        </span>
      </button>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => {
          const I = Icon[n.icon];
          return (
            <button key={n.to} className={`nav__item${active(path, n.to) ? " is-active" : ""}`} onClick={() => navigate(n.to)} aria-current={active(path, n.to) ? "page" : undefined}>
              <I /> <span>{n.label}</span>
              {n.chev ? <span className="nav__chev"><Icon.chev size={16} /></span> : null}
            </button>
          );
        })}
        <div className="nav__sep" />
        <button className={`nav__item${active(path, "/download") ? " is-active" : ""}`} onClick={() => navigate("/download")}>
          <Icon.download /> <span>Download Desktop</span>
        </button>
      </nav>
      {showUpsell ? (
        <div className="upsell">
          <h4>Unlock more with<br /><b>ORVYN Pro</b></h4>
          <ul>
            <li><Icon.check /> More monthly credits</li>
            <li><Icon.check /> Priority processing</li>
            <li><Icon.check /> Advanced models</li>
            <li><Icon.check /> Team features</li>
          </ul>
          <button className="btn btn--primary" style={{ width: "100%" }} onClick={() => navigate("/billing#plans")}>Upgrade Now</button>
        </div>
      ) : null}
    </aside>
  );
}

function TopBar() {
  const { me, billing, signOut } = useStore();
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, []);
  const available = billing?.wallet.availableBalance ?? 0;
  const name = me?.user.name || me?.user.email || "";
  return (
    <header className="top">
      <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/files?q=${encodeURIComponent(q.trim())}`); }}>
        <Icon.search size={20} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files, chats, and projects…" aria-label="Search" />
        <kbd>Ctrl K</kbd>
      </form>
      <div className="top__spacer" />
      <div className="modelsel">
        <span className="modelsel__label">Model</span>
        <div>
          <ModelPicker />
          <div className="modelsel__hint">Best model for your request</div>
        </div>
      </div>
      <button className="credits-pill" onClick={() => navigate("/billing#credits")} data-testid="credits-pill" title="Credits available">
        <Icon.coins size={22} /> {num(available)} Credits
        <span className="credits-pill__plus"><Icon.plus size={18} /></span>
      </button>
      <button className="bell" aria-label="Notifications" onClick={() => navigate("/billing")}><Icon.bell /></button>
      <div ref={menuRef} style={{ position: "relative" }}>
        <button className="me" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="me__avatar"><img src={icon} alt="" /></span>
          <span>
            <div className="me__name" data-testid="me-name">{name}</div>
            <div className="me__plan">{billing?.wallet.plan.label ?? "Free"} Plan</div>
          </span>
          <Icon.down size={16} />
        </button>
        {menu ? (
          <div className="mp__menu" role="menu" style={{ width: 220 }}>
            <button className="mp__item" role="menuitem" onClick={() => { setMenu(false); navigate("/settings"); }}><Icon.user size={18} /> <b>Account settings</b></button>
            <button className="mp__item" role="menuitem" onClick={() => { setMenu(false); navigate("/billing"); }}><Icon.billing size={18} /> <b>Billing</b></button>
            {me?.staff ? <button className="mp__item" role="menuitem" onClick={() => { setMenu(false); const u = adminUrl(); if (u.startsWith("/")) navigate(u); else location.href = u; }} data-testid="open-admin"><Icon.shield size={18} /> <b>Admin Portal</b></button> : null}
            <button className="mp__item" role="menuitem" onClick={() => { setMenu(false); void signOut(); }} data-testid="sign-out"><Icon.logout size={18} /> <b>Sign out</b></button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
