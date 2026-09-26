import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface RegistrySkill {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  builtin: boolean;
  installed: boolean;
  enabled: boolean;
  deletable: boolean;
  requiredTools: string[];
  trigger: string;
  validation: string;
  source: string;
  instructions: string;
}

type Tab = "installed" | "builtin" | "mine";

export function SkillsPage() {
  const [skills, setSkills] = useState<RegistrySkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(apiUrl("/skills/registry"), { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("The skill registry is unavailable"))))
      .then((body: { skills?: RegistrySkill[] }) => {
        setSkills(Array.isArray(body.skills) ? body.skills : []);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "The skill registry is unavailable"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = skills.filter((skill) => {
    if (tab === "mine") return !skill.builtin;
    if (tab === "builtin") return skill.builtin;
    return skill.installed;
  });
  const selected = skills.find((skill) => skill.id === selectedId) ?? null;

  async function setEnabled(skill: RegistrySkill, enabled: boolean) {
    setSavingId(skill.id);
    try {
      const res = await fetch(apiUrl(`/skills/registry/${encodeURIComponent(skill.id)}`), {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not update the skill.");
      const next = body.skill as RegistrySkill | undefined;
      setSkills((rows) => rows.map((row) => (row.id === skill.id ? { ...row, ...(next ?? { enabled }) } : row)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the skill.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="skills-page">
      <div className="usage-page__head">
        <div className="usage-page__title">
          <h1>Skills</h1>
          <div className="usage-pills" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "installed"} className={tab === "installed" ? "is-on" : ""} onClick={() => setTab("installed")}>Installed</button>
            <button type="button" role="tab" aria-selected={tab === "builtin"} className={tab === "builtin" ? "is-on" : ""} onClick={() => setTab("builtin")}>Built-in</button>
            <button type="button" role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "is-on" : ""} onClick={() => setTab("mine")}>My Skills</button>
          </div>
        </div>
      </div>
      <p className="settings-lead">Playbooks ORVYN can follow. Built-in skills ship with the app and stay installed.</p>
      {error && <p className="usage-error">{error}</p>}
      {loading && skills.length === 0 && <p className="usage-muted">Loading skills…</p>}
      <div className={`skills-layout${selected ? " has-detail" : ""}`}>
        <div className="skills-list">
          {visible.map((skill) => (
            <article key={skill.id} className={`skills-card${selectedId === skill.id ? " is-on" : ""}`}>
              <button type="button" className="skills-card__open" onClick={() => setSelectedId(skill.id)}>
                <div className="skills-card__title">
                  <b>{skill.name}</b>
                  {skill.builtin && <span className="skills-badge">Built-in</span>}
                </div>
                <p>{skill.description}</p>
                <div className="skills-card__meta">
                  <span>{skill.category}</span>
                  <span>v{skill.version}</span>
                  <span>{skill.requiredTools.length} tools</span>
                  <span>{skill.enabled ? "Enabled" : "Disabled"}</span>
                </div>
              </button>
              <div className="skills-card__switch">
                <span>{skill.enabled ? "On" : "Off"}</span>
                <button
                  type="button"
                  className={`settings-toggle${skill.enabled ? " is-on" : ""}`}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  aria-pressed={skill.enabled}
                  disabled={savingId === skill.id}
                  onClick={() => setEnabled(skill, !skill.enabled)}
                >
                  <i />
                </button>
              </div>
            </article>
          ))}
          {!loading && visible.length === 0 && (
            <p className="usage-muted">{tab === "mine" ? "You have not added any skills yet." : "No skills are installed."}</p>
          )}
        </div>
        {selected && (
          <aside className="skills-detail" aria-label={selected.name}>
            <div className="skills-detail__head">
              <button type="button" className="skills-detail__back" onClick={() => setSelectedId(null)}>Back</button>
              <div className="skills-card__title">
                <h2>{selected.name}</h2>
                {selected.builtin && <span className="skills-badge">Built-in</span>}
              </div>
              <button
                type="button"
                className={`settings-toggle${selected.enabled ? " is-on" : ""}`}
                aria-label={`${selected.enabled ? "Disable" : "Enable"} ${selected.name}`}
                aria-pressed={selected.enabled}
                disabled={savingId === selected.id}
                onClick={() => setEnabled(selected, !selected.enabled)}
              >
                <i />
              </button>
            </div>
            <p>{selected.description}</p>
            <dl className="skills-facts">
              <div><dt>Version</dt><dd>{selected.version}</dd></div>
              <div><dt>Source</dt><dd>{selected.source}</dd></div>
              <div><dt>Category</dt><dd>{selected.category}</dd></div>
              <div><dt>State</dt><dd>{selected.enabled ? "Enabled" : "Disabled"}</dd></div>
              <div><dt>Triggers</dt><dd>{selected.trigger}</dd></div>
              <div><dt>Required tools</dt><dd>{selected.requiredTools.join(", ")}</dd></div>
              <div><dt>Validation rule</dt><dd>{selected.validation}</dd></div>
            </dl>
            <h3>SKILL.md</h3>
            <pre className="skills-md">{selected.instructions}</pre>
            {selected.builtin && <p className="usage-muted">Built-in skills cannot be deleted.</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
