import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { UsageStatsPage } from "./UsageStatsPage";
import logo from "../assets/logo-lockup.png";
import mark from "../assets/icon.png";
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

interface Provider {
  id: string;
  name: string;
  desc: string;
  warn?: boolean;
  connected?: boolean;
  blurb: string;
  baseUrl: string;
  format: string;
}

const PROVIDERS: Provider[] = [
  { id: "auto", name: "ORVYN Auto", desc: "Best model for your task", blurb: "ORVYN picks the lowest-cost model that can finish the task, then escalates only when the work needs it.", baseUrl: "https://orvyn.virphoneusa.com/v1", format: "ORVYN lane" },
  { id: "openai", name: "OpenAI", desc: "Official OpenAI models", connected: true, blurb: "Access to OpenAI's latest models including GPT-5, GPT-4 and reasoning models.", baseUrl: "https://api.openai.com/v1", format: "Responses (v1)" },
  { id: "anthropic", name: "Anthropic", desc: "Claude models", blurb: "Claude models for long context, coding recovery, and careful reasoning.", baseUrl: "https://api.anthropic.com", format: "Messages (v1)" },
  { id: "fireworks", name: "Fireworks", desc: "Fast inference", blurb: "Low-latency open models for fast answers and image generation.", baseUrl: "https://api.fireworks.ai/inference/v1", format: "Chat completions" },
  { id: "gemini", name: "Gemini", desc: "Google models", blurb: "Gemini models for long context and multimodal reading.", baseUrl: "https://generativelanguage.googleapis.com/v1beta", format: "Generate content" },
  { id: "openrouter", name: "OpenRouter", desc: "Access 300+ models", warn: true, blurb: "One key for hundreds of models. ORVYN still bills the lane, not the raw provider price.", baseUrl: "https://openrouter.ai/api/v1", format: "Chat completions" },
  { id: "custom", name: "Custom Provider", desc: "Any OpenAI-compatible API", blurb: "Point ORVYN at an OpenAI-compatible base URL and key.", baseUrl: "https://", format: "Chat completions" },
];

const MODELS = [
  { name: "GPT-5.6 Sol", window: "1M", caps: ["Vision", "Reasoning", "Tools"], mark: "sol" },
  { name: "GPT-5.6 Luna", window: "1M", caps: ["Vision", "Tools"], mark: "luna" },
  { name: "GPT-5.6 Terra", window: "1M", caps: ["Vision", "Tools"], mark: "terra" },
  { name: "GPT-5.4", window: "1M", caps: ["Vision", "Tools"], mark: "gpt" },
  { name: "GLM-5.3", window: "1M", caps: ["Vision", "Code"], mark: "glm" },
  { name: "Kimi K2.7 Code", window: "1M", caps: ["Code", "Tools"], mark: "kimi" },
  { name: "Claude 4 Sonnet", window: "200K", caps: ["Vision", "Tools"], mark: "claude" },
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
  const [providerId, setProviderId] = useState("openai");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ openai: true, auto: true, anthropic: true, fireworks: true, gemini: true, openrouter: true, custom: true });
  const [modelsOn, setModelsOn] = useState<Record<string, boolean>>(() => Object.fromEntries(MODELS.map((m) => [m.name, true])));
  const [showKey, setShowKey] = useState(false);
  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[1];

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
          <ModelSettings
            provider={provider}
            enabled={enabled[provider.id] !== false}
            onToggleEnabled={() => setEnabled((s) => ({ ...s, [provider.id]: s[provider.id] === false }))}
            onPick={setProviderId}
            showKey={showKey}
            onToggleKey={() => setShowKey((v) => !v)}
            modelsOn={modelsOn}
            onToggleModel={(name) => setModelsOn((s) => ({ ...s, [name]: !s[name] }))}
          />
        ) : section === "usage" ? (
          <UsageStatsPage />
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

function ModelSettings({
  provider, enabled, onToggleEnabled, onPick, showKey, onToggleKey, modelsOn, onToggleModel,
}: {
  provider: Provider;
  enabled: boolean;
  onToggleEnabled: () => void;
  onPick: (id: string) => void;
  showKey: boolean;
  onToggleKey: () => void;
  modelsOn: Record<string, boolean>;
  onToggleModel: (name: string) => void;
}) {
  return (
    <>
      <h1>Model settings</h1>
      <p className="settings-lead">Manage model providers and configure access to AI models. Once configured, they can be selected during chat.</p>
      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card__head">
            Providers
            <button type="button" className="settings-icon-btn" aria-label="Add provider">+</button>
          </div>
          {PROVIDERS.map((p) => (
            <button key={p.id} type="button" className={`settings-provider${p.id === provider.id ? " is-on" : ""}`} onClick={() => onPick(p.id)}>
              <span className="settings-provider__mark">{p.id === "auto" ? <img src={mark} alt="" /> : <ProviderMark id={p.id} />}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="settings-provider__name">{p.name}</span>
                <span className="settings-provider__desc">{p.desc}</span>
              </span>
              {p.id === "custom" ? <span style={{ color: "#8b97b0" }}>+</span> : <span className={`settings-dot${p.warn ? " is-warn" : ""}`} />}
            </button>
          ))}
        </section>
        <div>
          <section className="settings-card">
            <div className="settings-provider-head">
              <span className="settings-provider__mark" style={{ width: 40, height: 40 }}><ProviderMark id={provider.id} /></span>
              <div style={{ minWidth: 0 }}>
                <h2>
                  {provider.name}
                  {provider.connected && <span className="settings-connected">Connected</span>}
                </h2>
                <p>{provider.blurb}</p>
              </div>
              <div className="settings-head-actions">
                <span>Enabled</span>
                <Toggle on={enabled} onClick={onToggleEnabled} label={`${provider.name} enabled`} />
                <button type="button" className="settings-gear" aria-label="Provider menu">···</button>
              </div>
            </div>
            <div className="settings-fields">
              <div className="settings-field">
                <label>Base URL</label>
                <input readOnly value={provider.baseUrl} />
              </div>
              <div className="settings-field">
                <label>API format</label>
                <select defaultValue={provider.format}><option>{provider.format}</option></select>
              </div>
            </div>
            <div className="settings-key">
              <label>API key</label>
              <div className="settings-key__row">
                <input readOnly type={showKey ? "text" : "password"} value="sk-orvyn-demo-key-000000" />
                <button type="button" onClick={onToggleKey} aria-label={showKey ? "Hide API key" : "Show API key"}><Eye /></button>
                <button type="button">Get API key ↗</button>
              </div>
            </div>
          </section>

          <section className="settings-card settings-quota">
            <div className="settings-quota__top">
              <b>Usage & quota</b>
              <span>
                <span className="settings-renew">Renews Sep 30, 2025</span>
                <button type="button" className="settings-manage">Manage plan</button>
              </span>
            </div>
            <div className="settings-meters">
              <Meter icon={<Clock />} label="5-hour remaining" pct="100%" sub="21:31 left" width="100%" />
              <Meter icon={<Cal />} label="Weekly remaining" pct="15%" sub="12K / 80K requests" width="15%" />
              <Meter icon={<Card />} label="Monthly credits" pct="62%" sub="248K / 400K" width="62%" />
              <Meter icon={<Spark />} label="ZCode MCP" pct="100%" sub="Included" width="100%" />
            </div>
          </section>

          <section className="settings-card settings-models">
            <div className="settings-models__top">
              <b>Model list</b>
              <button type="button" className="settings-add">+ Add model</button>
            </div>
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Model name</th>
                  <th>Context window</th>
                  <th>Capabilities</th>
                  <th>Actions</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {MODELS.map((m) => (
                  <tr key={m.name}>
                    <td>
                      <span className="settings-model"><ModelGlyph kind={m.mark} /> {m.name}</span>
                    </td>
                    <td>{m.window}</td>
                    <td>
                      <span className="settings-caps">{m.caps.map((c) => <span key={c} className="settings-cap">{c}</span>)}</span>
                    </td>
                    <td>
                      <span className="settings-row-actions">
                        <button type="button" aria-label={`Configure ${m.name}`}><Sliders /></button>
                        <button type="button" aria-label={`Edit ${m.name}`}><Pencil /></button>
                      </span>
                    </td>
                    <td><Toggle on={modelsOn[m.name] !== false} onClick={() => onToggleModel(m.name)} label={`${m.name} enabled`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </>
  );
}

function Meter({ icon, label, pct, sub, width }: { icon: React.ReactNode; label: string; pct: string; sub: string; width: string }) {
  return (
    <div className="settings-meter">
      <div className="settings-meter__label">{icon}{label}</div>
      <div className="settings-meter__pct">{pct}</div>
      <div className="settings-meter__sub">{sub}</div>
      <div className="settings-bar"><div style={{ width }} /></div>
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return <button type="button" className={`settings-toggle${on ? " is-on" : ""}`} aria-pressed={on} aria-label={label} onClick={onClick}><i /></button>;
}

function ProviderMark({ id }: { id: string }) {
  if (id === "auto") return <img src={mark} alt="" style={{ width: 22, height: 22 }} />;
  if (id === "openai") return <OpenAIMark />;
  if (id === "anthropic") return <span style={{ fontWeight: 700, fontSize: 14 }}>A</span>;
  if (id === "fireworks") return <Spark />;
  if (id === "gemini") return <span style={{ color: "#7aa2ff" }}>✦</span>;
  if (id === "openrouter") return <span style={{ fontSize: 12 }}>⇆</span>;
  return <Box />;
}

function ModelGlyph({ kind }: { kind: string }) {
  const color = kind === "sol" ? "#7aa2ff" : kind === "luna" ? "#c4bfff" : kind === "terra" ? "#86efac" : kind === "glm" ? "#c4b5fd" : kind === "kimi" ? "#93c5fd" : kind === "claude" ? "#fdba74" : "#9aa6bd";
  return <span style={{ color, width: 16, display: "inline-grid", placeItems: "center" }}>{kind === "claude" ? "✶" : kind === "kimi" ? "K" : kind === "glm" ? "✧" : "◎"}</span>;
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
function OpenAIMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.2c.7 0 1.3.4 1.6 1l2.2 3.8 4.4.6c.7.1 1.2.6 1.3 1.3.1.7-.2 1.3-.7 1.8l-3.2 3.1.8 4.3c.1.7-.2 1.4-.8 1.8-.6.4-1.3.4-1.9.1L12 18.1 8.3 20c-.6.3-1.3.3-1.9-.1-.6-.4-.9-1.1-.8-1.8l.8-4.3-3.2-3.1c-.5-.5-.8-1.1-.7-1.8.1-.7.6-1.2 1.3-1.3l4.4-.6 2.2-3.8c.3-.6.9-1 1.6-1z" />
    </svg>
  );
}
