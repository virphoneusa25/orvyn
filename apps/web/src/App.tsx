import { lazy, Suspense, useEffect, useState } from "react";
import { setViewAsToken } from "./lib/api";
import { surface } from "./lib/surface";
import { StoreProvider, useStore } from "./lib/store";
import { match, navigate, useLocation } from "./lib/router";
import { PreviewProvider } from "./components/Preview";
import { Shell } from "./components/Shell";
import { SignIn, FinishSetup } from "./pages/SignIn";
import { Home } from "./pages/Home";
import { Chats } from "./pages/Chats";
import { Projects, ProjectDetail } from "./pages/Projects";
import { Files } from "./pages/Files";
import { Usage } from "./pages/Usage";
import { Billing } from "./pages/Billing";
import { Settings } from "./pages/Settings";
import { Help } from "./pages/Help";
import { Download } from "./pages/Download";
import { InvitePage, SharedChat, pendingInvite, rememberInvite } from "./pages/Public";

export function App() {
  return (
    <StoreProvider>
      <PreviewProvider>
        <Root />
        <Toast />
      </PreviewProvider>
    </StoreProvider>
  );
}

function Toast() {
  const { toastMsg } = useStore();
  return toastMsg ? <div className="toast" role="status">{toastMsg}</div> : null;
}

function Root() {
  const { status } = useStore();
  const { path } = useLocation();

  // Signed-in people never sit on /signin; signed-out people only see it.
  useEffect(() => {
    if (status !== "loading" && status !== "signed-out" && path === "/signin") navigate(surface === "admin" ? "/admin" : "/", { replace: true });
  }, [status, path]);

  // Signed in with an invitation still waiting (it was opened before signing in): show it.
  useEffect(() => {
    if (status === "ready" && path !== "/invite" && !path.startsWith("/share/") && pendingInvite()) navigate("/invite", { replace: true });
  }, [status, path]);

  if (path === "/view-as") return <ViewAsLanding />;
  // A shared conversation is public (read-only, text only): no account needed.
  if (path.startsWith("/share/")) return <SharedChat token={decodeURIComponent(path.slice(7))} />;
  // An invitation opened while signed out: remember it through sign-in / sign-up.
  if (path === "/invite" && status === "signed-out") { const t = new URLSearchParams(location.search).get("token"); if (t) rememberInvite(t); }
  if (status === "loading") return <div className="auth"><div className="muted">Loading ORVYN…</div></div>;
  if (status === "signed-out") return <SignIn />;
  // The Admin Portal: its own shell and its own server-side check (staff only).
  if (path === "/admin" || path.startsWith("/admin/")) return <Suspense fallback={<div className="auth"><div className="muted">Loading Admin Portal…</div></div>}><AdminApp /></Suspense>;
  if (status === "paused") return <Paused />;
  if (status === "gated") return <FinishSetup />;
  return <><ViewAsBanner /><Shell>{page(path)}</Shell></>;
}

const AdminApp = lazy(() => import("./admin/AdminApp"));

/** A staff "View as customer" tab: receives its read-only token from the Admin Portal tab by message (never in a URL). */
function ViewAsLanding() {
  const [msg, setMsg] = useState("Waiting for the Admin Portal…");
  useEffect(() => {
    const on = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== window.opener || ev.data?.type !== "orvyn:view-as" || typeof ev.data.token !== "string") return;
      setViewAsToken(ev.data.token);
      location.replace("/");
    };
    window.addEventListener("message", on);
    if (window.opener) window.opener.postMessage({ type: "orvyn:view-as-ready" }, location.origin);
    else setMsg("Open a customer view from the Admin Portal.");
    return () => window.removeEventListener("message", on);
  }, []);
  return <div className="auth"><div className="muted" data-testid="view-as-landing">{msg}</div></div>;
}

function ViewAsBanner() {
  const { me, signOut } = useStore();
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30_000); return () => window.clearInterval(t); }, []);
  if (!me?.viewAs) return null;
  const mins = Math.max(0, Math.round((me.viewAs.expiresAt - Date.now()) / 60_000));
  return (
    <div className="viewas-banner" role="alert" data-testid="view-as-banner">
      <b>Support view</b>&nbsp;— you're seeing {me.principal.organizationName} ({me.user.email}) read-only as {me.viewAs.staffEmail}. Nothing can be changed or sent. Ends in {mins} min.
      {me.viewAs.paused ? <span>&nbsp;· This account is paused.</span> : null}
      <button className="btn btn--sm" onClick={() => void signOut()}>End view</button>
    </div>
  );
}

function Paused() {
  const { signOut, me } = useStore();
  return (
    <div className="auth" data-testid="account-paused">
      <div className="card auth__card" style={{ textAlign: "center" }}>
        <h1>Your account is paused</h1>
        <p className="sub">Access to ORVYN for {me?.principal.organizationName ?? "this account"} is paused. Your projects, chats and files are safe and unchanged. Contact ORVYN support to restore access.</p>
        <a className="btn btn--primary btn--big" href="mailto:support@virphoneusa.com">Contact support</a>
        <div className="auth__links" style={{ justifyContent: "center" }}><button className="linkbtn" onClick={() => void signOut()}>Sign out</button></div>
      </div>
    </div>
  );
}

function page(path: string): React.ReactNode {
  let m: Record<string, string> | null;
  if (path === "/" || path === "/home" || path === "/signin") return <Home />;
  if (path === "/chats") return <Chats />;
  if ((m = match("/chats/:id", path))) return <Chats id={m.id} />;
  if (path === "/projects") return <Projects />;
  if ((m = match("/projects/:id", path))) return <ProjectDetail id={m.id!} />;
  if ((m = match("/projects/:id/chats/:chat", path))) return <ProjectDetail id={m.id!} chat={m.chat} />;
  if (path === "/files") return <Files />;
  if (path === "/usage") return <Usage />;
  if (path === "/billing") return <Billing />;
  if (path === "/settings") return <Settings />;
  if ((m = match("/settings/:tab", path))) return <Settings tab={m.tab} />;
  if (path === "/invite") return <InvitePage />;
  if (path === "/help") return <Help />;
  if (path === "/download") return <Download />;
  return (
    <div className="page"><div className="card empty">
      <h3>Page not found</h3>
      That page doesn't exist or has moved.
      <div><button className="btn" onClick={() => navigate("/")}>Go home</button></div>
    </div></div>
  );
}
