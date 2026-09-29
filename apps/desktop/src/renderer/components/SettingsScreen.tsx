import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { SkillsPage } from "./SkillsPage";
import { UsageStatsPage } from "./UsageStatsPage";
import { ModelManager } from "./ModelManager";
import { BillingPanel } from "./BillingPanel";
import { AccountSecurity } from "./AccountSecurity";
import logo from "../assets/logo-lockup.png";
import "../styles/settings-screen.css";

type SectionId =
  | "general" | "appearance" | "models" | "browser" | "computer" | "shortcuts"
  | "memory" | "subagents" | "plugins" | "mcp" | "skills" | "commands" | "hooks"
  | "usage" | "billing" | "security" | "vault" | "cloud";

const NAV: { label: string; items: { id: SectionId; label: string; icon: React.ReactNode }[] }[] = [
  {
    label: "APP SETTINGS",
    items: [
      { id: "general", label: "General", icon: <Sliders /> },
      { id: "appearance", label: "Appearance", icon: <Sun /> },
      { id: "models", label: "Model settings", icon: <Cpu /> },
      { id: "browser", label: "Browser Use", icon: <Globe /> },
      { id: "computer", label: "Computer Use", icon: <Monitor /> },
      { id: "shortcuts", label: "Keyboard Shortcuts", icon: <Keyboard /> },
    ],
  },
  {
    label: "AI AGENT CAPABILITIES",
    items: [
      { id: "memory", label: "Memory", icon: <Brain /> },
      { id: "subagents", label: "Subagents", icon: <Users /> },
      { id: "plugins", label: "Plugins", icon: <Puzzle /> },
      { id: "mcp", label: "MCP Servers", icon: <Server /> },
      { id: "skills", label: "Skills", icon: <Spark /> },
      { id: "commands", label: "Commands", icon: <Terminal /> },
      { id: "hooks", label: "Hooks", icon: <Webhook /> },
    ],
  },
  {
    label: "ACCOUNT & DATA",
    items: [
      { id: "usage", label: "Usage & Stats", icon: <Chart /> },
      { id: "billing", label: "Billing", icon: <Card /> },
      { id: "security", label: "Security", icon: <Shield /> },
      { id: "vault", label: "Vault / Secrets", icon: <Lock /> },
      { id: "cloud", label: "Cloud & Execution", icon: <Cloud /> },
    ],
  },
];

export function SettingsScreen({
  userName,
  planLabel,
  onBack,
}: {
  userName: string;
  planLabel: string;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SectionId>("models");
  const [livePlan, setLivePlan] = useState(planLabel);
  useEffect(() => {
    let cancel = false;
    fetch(apiUrl("/billing"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const label = body?.wallet?.plan?.label;
        if (!cancel && typeof label === "string" && label) setLivePlan(`${label} Plan`);
      })
      .catch(() => undefined);
    return () => { cancel = true; };
  }, []);
  return (
    <div className="settings-screen">
      <aside className="settings-side">
        <img className="settings-logo" src={logo} alt="ORVYN" />
        <button type="button" className="settings-back" onClick={onBack}>
          <ChevronLeft /> Back to workspace
        </button>
        <nav className="settings-nav" aria-label="Settings">
          {NAV.map((group) => (
            <div key={group.label}>
              <div className="settings-nav__label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="settings-nav__item"
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-user">
          <span className="settings-avatar">{userName.slice(0, 1).toUpperCase() || "O"}</span>
          <span className="settings-user__text">
            <span className="settings-user__name">{userName}</span>
            <span className="settings-user__plan">{livePlan}</span>
          </span>
          <button type="button" className="settings-gear" aria-label="Settings" onClick={() => setSection("models")}>
            <Gear />
          </button>
        </div>
      </aside>
      <main className="settings-main">
        {section === "models" ? (
          <ModelManager />
        ) : section === "billing" ? (
          <BillingPanel />
        ) : section === "security" ? (
          <AccountSecurity />        ) : section === "usage" ? (
          <UsageStatsPage />
        ) : section === "skills" ? (
          <SkillsPage />
        ) : (
          <section>
            <h1>{NAV.flatMap((g) => g.items).find((i) => i.id === section)?.label}</h1>
            <p className="settings-lead">This section uses the same settings shell. Model providers, keys, and the model list are on Model settings.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function Svg({ children }: { children: React.ReactNode }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
function ChevronLeft() { return <Svg><path d="m15 18-6-6 6-6" /></Svg>; }
function Sliders() { return <Svg><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" /></Svg>; }
function Sun() { return <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>; }
function Cpu() { return <Svg><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></Svg>; }
function Globe() { return <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z" /></Svg>; }
function Monitor() { return <Svg><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>; }
function Keyboard() { return <Svg><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></Svg>; }
function Brain() { return <Svg><path d="M9 18a4 4 0 0 1-4-4 3 3 0 0 1 1-5 4 4 0 0 1 7-2 4 4 0 0 1 6 3 3 3 0 0 1 0 6 4 4 0 0 1-4 4" /><path d="M12 18V9" /></Svg>; }
function Users() { return <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="3" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>; }
function Puzzle() { return <Svg><path d="M8 4h3a2 2 0 1 1 0 4h1v2h2a2 2 0 1 1 0 4h-2v3H8v-3H6a2 2 0 1 1 0-4h2V8H6a2 2 0 0 1 0-4h2z" /></Svg>; }
function Server() { return <Svg><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /><path d="M7 7h.01M7 17h.01" /></Svg>; }
function Spark() { return <Svg><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /></Svg>; }
function Terminal() { return <Svg><path d="m5 8 4 4-4 4M12 16h7" /></Svg>; }
function Webhook() { return <Svg><path d="M18 16a3 3 0 1 0-2.8-4M6 8a3 3 0 1 0 2.8 4M8 16l8-8" /></Svg>; }
function Chart() { return <Svg><path d="M4 19V5M4 19h16" /><path d="M8 16v-5M12 16V8M16 16v-3" /></Svg>; }
function Card() { return <Svg><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></Svg>; }
function Shield() { return <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>; }
function Lock() { return <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>; }
function Cloud() { return <Svg><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12 3.5 3.5 0 0 0 6 19z" /></Svg>; }
function Gear() { return <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.1-2.7V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 4.6 15H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5.3z" /></Svg>; }
function Pencil() { return <Svg><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Svg>; }
function Clock() { return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></Svg>; }
function Cal() { return <Svg><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Svg>; }
function Box() { return <Svg><path d="M21 8 12 3 3 8l9 5 9-5zM3 8v8l9 5 9-5V8" /></Svg>; }
function Eye() { return <Svg><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>; }
