// apps/desktop/src/renderer/helpContent.ts
//
// Static, local Getting Started copy. No internal config or secrets.

export interface HelpTopic {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "what",
    title: "What ORVYN is",
    tags: ["orvyn", "overview", "orion"],
    body: "ORVYN is your local and cloud AI co-worker. ORION plans and executes missions — code, servers, research, deploys — while you stay in control of permissions, models, and the workspace.",
  },
  {
    id: "mission",
    title: "Start a new mission",
    tags: ["missions", "home", "composer"],
    body: "On Home, describe the outcome in the composer and press Run mission (Ctrl+Enter). In Chat, type a follow-up and press Enter. Work streams in the center. The Workbench on the right is an IDE surface: Changes, Desktop, Browser, live Preview tabs, Files, Diff, Terminal, and Review.",
  },
  {
    id: "modes",
    title: "Auto / Code / Server / Research / Deploy / Automate",
    tags: ["modes", "auto", "code", "server", "research", "deploy", "automate"],
    body: "Auto classifies the request. Code edits the workspace. Server targets hosts and remote execution. Research investigates without assuming a deploy. Deploy is for release work. Automate currently runs as a one-shot plan — a scheduler is not shipped yet.",
  },
  {
    id: "models",
    title: "Select a model",
    tags: ["models", "composer"],
    body: "Use the model menu in the composer. Auto lets ORVYN pick from the live registry. A concrete model id applies only to this run or conversation — it does not rewrite other chats.",
  },
  {
    id: "reasoning",
    title: "Choose reasoning effort",
    tags: ["reasoning", "effort", "models"],
    body: "Fast, Standard, Deep, and Max are honored by models that declare support. Auto leaves the choice to the model. Effort never reveals hidden chain-of-thought in the stream.",
  },
  {
    id: "permissions",
    title: "Ask / Auto Read / Auto Workspace / Full Access",
    tags: ["permissions", "access", "tools", "approval"],
    body: "Ask prompts before tools run. Auto Read allows read-only tools. Auto Workspace allows project reads and writes that are not destructive. Full Access still cannot bypass hard-denied or destructive ToolGateway boundaries. Approvals stay authoritative.",
  },
  {
    id: "workspace",
    title: "Open a workspace",
    tags: ["workspace", "folder", "projects"],
    body: "File → Open Folder, or use the workspace control in the title bar / sidebar. Cloud mode only works inside authorized project roots. The built-in scratch folder is not a project.",
  },
  {
    id: "terminal",
    title: "Use the terminal",
    tags: ["terminal", "shell", "drawer"],
    body: "Click the title-bar Terminal button or press Ctrl+` to open the bottom drawer. This is a real local shell through Electron. The right-panel Terminal tab shows the same PTY infrastructure. Opening the drawer does not change permission policy.",
  },
  {
    id: "browser",
    title: "Use the browser",
    tags: ["browser", "playwright"],
    body: "Browser is for external docs and research. Local apps ORION starts open as Preview tabs (ORVYN :port) with a live iframe. Desktop is a real Chromium session ORION can control — Take Control hands the mouse to you without cancelling the run. Follow ORION switches Workbench tabs; a manual click pauses it.",
  },
  {
    id: "approve",
    title: "Approve tool actions",
    tags: ["permissions", "approval", "tools"],
    body: "When a tool needs approval, the stream shows the command and a diff when files change. Approve once or for the mission. Deny stops that call. Remembered approvals stay scoped.",
  },
  {
    id: "stop",
    title: "Stop a run",
    tags: ["stop", "run"],
    body: "Press Stop in the composer or Esc while a run is active. The run enters cancelling, then stops. Queued follow-ups remain until you remove them.",
  },
  {
    id: "queue",
    title: "Queue follow-up requests",
    tags: ["queue", "follow-up"],
    body: "Type while a run is active to enqueue a follow-up. The backend stores the queue, so reconnects do not lose it. Reorder, edit, or remove items from the composer queue strip.",
  },
  {
    id: "files",
    title: "View files and diffs",
    tags: ["files", "diff", "panel"],
    body: "The title-bar panel toggle opens the Workbench. Changes, Desktop, Browser, and live Preview tabs share one region. Follow ORION only switches the active tab. Clicking a file opens a Diff or editor tab in that same Workbench.",
  },
  {
    id: "cloud",
    title: "Reconnect to ORVYN Cloud",
    tags: ["cloud", "sign-in", "connection"],
    body: "Use the account control in the title bar to sign in to ORVYN Cloud, or open Connection Settings. Local Mode keeps work on this machine. Cloud Mode talks to the configured control plane — never paste API keys into chat.",
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    tags: ["shortcuts", "keyboard"],
    body: "Ctrl+Shift+P command palette · Ctrl+P quick open · Ctrl+L focus composer · Ctrl+` toggle terminal · Ctrl+Shift+B toggle Workbench · Ctrl+Shift+D focus Desktop · F1 help · Ctrl+Enter run from Home · Enter send in Chat · Esc stop / close menus.",
  },
  {
    id: "update",
    title: "Get desktop UI updates",
    tags: ["update", "desktop", "install", "windows"],
    body: "The installed Windows ORVYN app is a packaged Electron build. Pushing commits to git does not change that installed app. Check the status-bar Desktop SHA. To see new UI, install a build produced from the same commit (GitHub Actions artifact or npm run dist:win), or run npm run desktop:dev from a checkout of that branch.",
  },
];

export function filterHelpTopics(topics: HelpTopic[], query: string): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return topics;
  return topics.filter((t) => {
    if (t.title.toLowerCase().includes(q)) return true;
    if (t.body.toLowerCase().includes(q)) return true;
    return t.tags.some((tag) => tag.includes(q));
  });
}
