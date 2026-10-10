import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "../lib/api";
import { useStore } from "../lib/store";
import { adminUrl } from "../lib/surface";
import { navigate, useLocation } from "../lib/router";
import { num } from "../lib/format";
import { signal, useSignal } from "../lib/events";
import type { SessionRow } from "../lib/useApi";
import { Icon } from "./Icons";
import { Orb } from "./Orb";
import { ModelPicker } from "./ModelPicker";
import { CommandPalette } from "./CommandPalette";
import { Notifications } from "./Notifications";
import { useDismiss } from "./Menu";
import { hueFor, initials, workspaceLabel } from "./Bits";

const NAV: { to: string; label: string; icon: keyof typeof Icon }[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/chats", label: "Chats", icon: "chat" },
  { to: "/projects", label: "Projects", icon: "folder" },
  { to: "/files", label: "Files", icon: "file" },
];
const ACCOUNT_NAV: { to: string; label: string; icon: keyof typeof Icon }[] = [
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
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const full = path.startsWith("/chats") || /^\/projects\/[^/]+/.test(path);
  useEffect(() => { setMobileNav(false); }, [path]);
  // iOS keyboards shrink the visual viewport without resizing 100dvh.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (window.innerWidth <= 820) {
        document.documentElement.style.setProperty("--portal-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      } else {
        document.documentElement.style.removeProperty("--portal-viewport-height");
      }
    };
    resize();
    window.addEventListener("resize", resize);
    viewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", resize);
      document.documentElement.style.removeProperty("--portal-viewport-height");
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="app">
      <Sidebar path={path} open={mobileNav} onClose={() => setMobileNav(false)} />
      {mobileNav ? <button className="side-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} /> : null}
      <div className="main">
        <TopBar onSearch={() => setPalette(true)} onMenu={() => setMobileNav(true)} />
        <main className={`content${full ? " content--full" : ""}`}>{children}</main>
      </div>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
    </div>
  );
}

function Sidebar({ path, open, onClose }: { path: string; open: boolean; onClose: () => void }) {
  const { billing } = useStore();
  const [recents, setRecents] = useState<SessionRow[]>([]);
  const load = useCallback(() => {
    api<{ sessions: SessionRow[] }>("/sessions").then((r) => setRecents([...r.sessions].filter((s) => !s.projectRoot).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, 14))).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  useSignal("sessions", load);
  const planId = billing?.wallet.plan.id ?? "free";
  const showUpsell = planId === "free" || planId === "starter";
  const openChat = path.startsWith("/chats/") ? path.split("/")[2] : null;
  return (
    <aside className={`side${open ? " is-open" : ""}`} aria-label="Sidebar">
      <div className="side__mobile-head">
        <span>Navigation</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close navigation"><Icon.x size={20} /></button>
      </div>
      <button className="brand" onClick={() => { navigate("/"); onClose(); }} aria-label="ORVYN Cloud home">
        <span className="brand__mark"><Orb /></span>
        <span>
          <div className="brand__word">ORVYN</div>
          <div className="brand__sub">CLOUD</div>
        </span>
      </button>
      <button className="btn btn--primary side__new" onClick={() => { navigate("/chats?new=1"); signal("sessions"); onClose(); }} data-testid="side-new-chat" aria-label="New chat">
        <Icon.plus size={17} /> <span>New chat</span>
      </button>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => <NavItem key={n.to} path={path} {...n} />)}
      </nav>
      {recents.length && !path.startsWith("/chats") ? (
        <>
          <div className="nav__label">Recent</div>
          <div className="side__recents" data-testid="side-recents">
            {recents.map((s) => (
              <button key={s.sessionId} className={`side__recent${s.sessionId === openChat ? " is-on" : ""}`} onClick={() => navigate(`/chats/${s.sessionId}`)} title={s.title}>
                {s.title || "Conversation"}
              </button>
            ))}
          </div>
        </>
      ) : <div style={{ flex: 1 }} />}
      <nav className="nav" aria-label="Account">
        <div className="nav__label">Account</div>
        {ACCOUNT_NAV.map((n) => <NavItem key={n.to} path={path} {...n} />)}
        <NavItem path={path} to="/download" label="Download Desktop" icon="download" />
      </nav>
      <div className="side__foot">
        {showUpsell ? (
          <div className="upsell" data-testid="upsell">
            <b>Unlock more with ORVYN Pro</b>
            <span>More credits, advanced models and priority.</span>
            <button className="btn btn--primary btn--sm" onClick={() => navigate("/billing#plans")}>Upgrade</button>
          </div>
        ) : null}
        <WorkspaceSwitcher />
      </div>
    </aside>
  );
}

function NavItem({ path, to, label, icon }: { path: string; to: string; label: string; icon: keyof typeof Icon }) {
  const I = Icon[icon] as (p: { size?: number }) => JSX.Element;
  const on = active(path, to);
  return (
    <button className={`nav__item${on ? " is-active" : ""}`} onClick={() => navigate(to)} aria-current={on ? "page" : undefined} title={label}>
      <I /> <span>{label}</span>
    </button>
  );
}

/** The workspace this session is in; people in more than one team can switch here. */
function WorkspaceSwitcher() {
  const { me, billing, refresh, toast } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  if (!me) return null;
  const current = me.principal;
  const name = workspaceLabel({ name: current.organizationName, kind: current.organizationKind }, me.user.name);
  const switchTo = async (id: string) => {
    setOpen(false);
    try {
      const r = await api<{ token: string }>("/auth/switch-organization", { method: "POST", body: { organizationId: id } });
      setToken(r.token);
      await refresh();
      signal("sessions"); signal("projects"); signal("files");
      navigate("/");
      toast("Switched workspace.");
    } catch (err: any) { toast(err.message); }
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="ws" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} data-testid="workspace-switcher" title={name}>
        <span className="ws__avatar" style={{ background: hueFor(current.organizationName) }}>{initials(name)}</span>
        <span>
          <div className="ws__name">{name}</div>
          <div className="ws__sub">{billing?.wallet.plan.label ?? "Free"} plan · {current.role}</div>
        </span>
        <Icon.down size={14} />
      </button>
      {open ? (
        <div className="menu menu--left menu--up" role="menu" style={{ width: 250 }}>
          <div className="menu__head">Workspaces</div>
          {me.organizations.map((o) => (
            <button key={o.id} role="menuitem" className={`menu__item${o.id === current.organizationId ? " is-on" : ""}`} onClick={() => void switchTo(o.id)}>
              <span className="avatar-sm" style={{ width: 24, height: 24, borderRadius: 7, fontSize: 11, background: hueFor(o.name) }}>{initials(workspaceLabel(o, me.user.name))}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{workspaceLabel(o, me.user.name)}</span>
              {o.id === current.organizationId ? <Icon.check size={15} /> : null}
            </button>
          ))}
          <div className="menu__sep" />
          <button role="menuitem" className="menu__item" onClick={() => { setOpen(false); navigate("/settings/team"); }}><Icon.users size={16} /> Team & invitations</button>
        </div>
      ) : null}
    </div>
  );
}

function TopBar({ onSearch, onMenu }: { onSearch: () => void; onMenu: () => void }) {
  const { me, billing, signOut } = useStore();
  const [menu, setMenu] = useState(false);
  const ref = useDismiss<HTMLDivElement>(menu, () => setMenu(false));
  const available = billing?.wallet.availableBalance ?? 0;
  const name = me?.user.name || me?.user.email || "";
  return (
    <header className="top">
      <button className="iconbtn top__menu" onClick={onMenu} aria-label="Open navigation"><Icon.menu size={20} /></button>
      <button className="top__brand" onClick={() => navigate("/")} aria-label="ORVYN Cloud home"><span className="brand__mark"><Orb /></span><span>ORVYN</span></button>
      <button className="search" onClick={onSearch} aria-label="Search" data-testid="open-search">
        <Icon.search size={17} />
        <span>Search chats, projects and files…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="top__spacer" />
      <ModelPicker />
      <button className="credits-pill" onClick={() => navigate("/billing#credits")} data-testid="credits-pill" title="Credits available — add more">
        <Icon.coins size={17} /> <span className="credits-pill__label">{num(available)} Credits</span>
        <span className="credits-pill__plus"><Icon.plus size={15} /></span>
      </button>
      <Notifications />
      <div ref={ref} style={{ position: "relative" }}>
        <button className="me" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="me__avatar">{initials(me?.user.name, me?.user.email)}</span>
          <span>
            <div className="me__name" data-testid="me-name">{name}</div>
            <div className="me__plan">{billing?.wallet.plan.label ?? "Free"} plan</div>
          </span>
          <Icon.down size={14} />
        </button>
        {menu ? (
          <div className="menu menu--right menu--down" role="menu" style={{ width: 240 }}>
            <div className="menu__head"><b>{me?.user.name || "Your account"}</b>{me?.user.email}</div>
            <div className="menu__sep" />
            <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); navigate("/settings"); }}><Icon.user size={16} /> Account settings</button>
            <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); navigate("/settings/team"); }}><Icon.users size={16} /> Team</button>
            <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); navigate("/billing"); }}><Icon.billing size={16} /> Billing</button>
            <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); navigate("/help"); }}><Icon.help size={16} /> Help</button>
            {me?.staff ? <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); const u = adminUrl(); if (u.startsWith("/")) navigate(u); else location.href = u; }} data-testid="open-admin"><Icon.shield size={16} /> Admin Portal</button> : null}
            {me?.staff ? <a className="menu__item" role="menuitem" href="https://staging.orvyn.virphoneusa.com" target="_blank" rel="noopener noreferrer" onClick={() => setMenu(false)} data-testid="open-staging"><Icon.globe size={16} /> Staging Portal</a> : null}
            <div className="menu__sep" />
            <button className="menu__item" role="menuitem" onClick={() => { setMenu(false); void signOut(); }} data-testid="sign-out"><Icon.logout size={16} /> Sign out</button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
