import { useEffect } from "react";
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
    if (status === "ready" && path === "/signin") navigate("/", { replace: true });
  }, [status, path]);

  if (status === "loading") return <div className="auth"><div className="muted">Loading ORVYN…</div></div>;
  if (status === "signed-out") return <SignIn />;
  if (status === "gated") return <FinishSetup />;
  return <Shell>{page(path)}</Shell>;
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
  if (path === "/help") return <Help />;
  if (path === "/download") return <Download />;
  return (
    <div className="empty">
      <h3>Page not found</h3>
      <button className="btn" onClick={() => navigate("/")}>Go home</button>
    </div>
  );
}
