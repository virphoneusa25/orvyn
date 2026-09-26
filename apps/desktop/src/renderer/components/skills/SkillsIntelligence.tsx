import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import "../../styles/skills-intelligence.css";

type Tab = "all" | "builtin" | "imported" | "approved" | "revision" | "blocked";
type SortKey = "relevance" | "name" | "used" | "updated" | "quality";
type DetailTab = "overview" | "capabilities" | "files" | "tools" | "related" | "history";
type Tone = "green" | "amber" | "red" | "cyan";

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  group: string;
  tags: string[];
  triggers: string[];
  version: string;
  source: "builtin" | "imported";
  builtin: boolean;
  enabled: boolean;
  certificationStatus: string;
  qualityStatus: "approved" | "needs_revision" | "disabled" | null;
  qualityScore: number | null;
  publisher: string;
  author: string;
  updatedAt: string | null;
  requiredTools: string[];
  optionalTools: string[];
  unresolvedTools: Array<{ name: string; requirement: string }>;
}

interface CatalogCounts {
  total: number;
  builtin: number;
  imported: number;
  approved: number;
  needsRevision: number;
  disabled: number;
  certified: number;
  partiallySupported: number;
  blocked: number;
}

interface LoggedRank {
  id: string;
  name: string;
  score: number;
  tier: string;
  selected: boolean;
  source: "builtin" | "imported";
  tags: string[];
  category: string;
}

interface RouteSnapshot {
  at: string;
  instruction: string;
  candidateCount: number;
  selectedCount: number;
  rejectedByCapabilityCount: number;
  rejectedByScoreCount: number;
  reasonSummary: string;
  selected: LoggedRank[];
  additional: LoggedRank[];
  rejectedByCapability: Array<{ id: string; name: string; reason: string }>;
  rejectedByScore: Array<{ id: string; name: string; reason: string }>;
}

interface SkillEvent {
  at: string;
  type: string;
  detail: string;
  skillId?: string;
}

interface CatalogTool {
  name: string;
  requirement: string;
  registered: boolean;
  permissionMapped: boolean;
  available: boolean;
  availability: "available" | "unavailable" | "optional";
}

interface SkillFile {
  path: string;
  kind: string;
  bytes: number;
  executable: false;
  inert: boolean;
}

interface SkillDetail extends CatalogSkill {
  whenToUse: string | null;
  taskDomains: string[];
  runModes: string[];
  validationRule: string;
  permissions: Array<{ id: string; reason: string }>;
  origin: { repository: string; path: string; author: string; license: string; version: string; importedAt: string } | null;
  certificationBlockers: string[];
  files: SkillFile[];
  tools: { required: CatalogTool[]; optional: CatalogTool[]; unresolved: CatalogTool[] };
  related: Array<{ id: string; name: string; category: string }>;
  duplicates: Array<{ decision: string; otherId: string; otherName: string; reason: string }>;
  usage: null;
  successRate: null;
  lastUsed: null;
}

interface QualityView {
  generatedAt: string;
  totalChecked: number;
  approved: number;
  needsRevision: number;
  disabled: number;
  native: { total: number; approved: number; needsRevision: number; disabled: number };
  imported: { total: number; approved: number; needsRevision: number; disabled: number };
  brokenReferences: Array<{ id: string; name: string; paths: string[] }>;
  providerWording: Array<{ id: string; name: string; changes: number }>;
  unresolvedToolAssumptions: Array<{ id: string; name: string; detail: string }>;
  duplicates: Array<{ decision: string; leftName: string; rightName: string; reason: string }>;
  safetyViolations: Array<{ id: string; name: string; code: string; detail: string }>;
  disabledSkills: Array<{ id: string; name: string; issues: Array<{ code: string; detail: string }> }>;
}

const ROW_HEIGHT = 108;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", label: "All Skills" },
  { id: "builtin", label: "Built-in" },
  { id: "imported", label: "Imported" },
  { id: "approved", label: "Approved" },
  { id: "revision", label: "Needs Revision" },
  { id: "blocked", label: "Blocked" },
];

function badges(skill: Pick<CatalogSkill, "qualityStatus" | "certificationStatus">): Array<{ label: string; tone: Tone }> {
  const out: Array<{ label: string; tone: Tone }> = [];
  const quality = skill.qualityStatus;
  const cert = skill.certificationStatus;
  if (quality === "approved" && cert === "certified") out.push({ label: "Certified", tone: "green" });
  else if (quality === "approved") out.push({ label: "Approved", tone: "green" });
  else if (quality === "needs_revision") out.push({ label: "Needs Revision", tone: "amber" });
  else if (quality === "disabled") out.push({ label: "Disabled", tone: "red" });
  if (cert === "certified" && quality !== "approved") out.push({ label: "Certified", tone: "green" });
  if (cert === "partially_supported") out.push({ label: "Partially Supported", tone: "amber" });
  if (cert === "blocked") out.push({ label: "Blocked", tone: "red" });
  return out;
}

function lockedReason(skill: CatalogSkill): string | null {
  if (skill.certificationStatus === "blocked") return "Blocked until certification changes.";
  if (skill.qualityStatus === "disabled") return "Disabled by the quality review.";
  return null;
}

function matchesTab(skill: CatalogSkill, tab: Tab): boolean {
  if (tab === "builtin") return skill.source === "builtin";
  if (tab === "imported") return skill.source === "imported";
  if (tab === "approved") return skill.qualityStatus === "approved";
  if (tab === "revision") return skill.qualityStatus === "needs_revision";
  if (tab === "blocked") return skill.qualityStatus === "disabled" || skill.certificationStatus === "blocked";
  return true;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function ratio(score: number, top: number): string {
  if (!top) return String(score);
  return (score / top).toFixed(2);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { headers: authHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export function SkillsIntelligence() {
  const [skills, setSkills] = useState<CatalogSkill[]>([]);
  const [counts, setCounts] = useState<CatalogCounts | null>(null);
  const [categories, setCategories] = useState<Array<{ label: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [group, setGroup] = useState("All");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteSnapshot | null>(null);
  const [events, setEvents] = useState<SkillEvent[]>([]);
  const [showRun, setShowRun] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const [quality, setQuality] = useState<QualityView | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadCatalog = React.useCallback(() => {
    setLoading(true);
    getJson<{ skills: CatalogSkill[]; counts: CatalogCounts; categories: Array<{ label: string; count: number }> }>("/skills/catalog")
      .then((body) => {
        setSkills(body.skills ?? []);
        setCounts(body.counts ?? null);
        setCategories(body.categories ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "The skill catalog is unavailable."))
      .finally(() => setLoading(false));
  }, []);

  const loadRoute = React.useCallback(() => {
    getJson<{ route: RouteSnapshot | null }>("/skills/routing/latest")
      .then((body) => setRoute(body.route ?? null))
      .catch(() => setRoute(null));
    getJson<{ events: SkillEvent[] }>("/skills/events")
      .then((body) => setEvents(body.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => {
    loadRoute();
    const timer = window.setInterval(loadRoute, 8000);
    window.addEventListener("focus", loadRoute);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", loadRoute);
    };
  }, [loadRoute]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailError(null);
    getJson<{ skill: SkillDetail }>(`/skills/catalog/${encodeURIComponent(selectedId)}`)
      .then((body) => { if (alive) setDetail(body.skill); })
      .catch((err: unknown) => { if (alive) setDetailError(err instanceof Error ? err.message : "Could not load this skill."); });
    return () => { alive = false; };
  }, [selectedId]);

  const scores = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of route?.selected ?? []) map.set(row.id, row.score);
    for (const row of route?.additional ?? []) map.set(row.id, row.score);
    return map;
  }, [route]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = skills.filter((skill) => {
      if (!matchesTab(skill, tab)) return false;
      if (group !== "All" && skill.group !== group) return false;
      if (source === "builtin" && skill.source !== "builtin") return false;
      if (source === "imported" && skill.source !== "imported") return false;
      if (status === "approved" && skill.qualityStatus !== "approved") return false;
      if (status === "needs_revision" && skill.qualityStatus !== "needs_revision") return false;
      if (status === "disabled" && skill.qualityStatus !== "disabled") return false;
      if (status === "certified" && skill.certificationStatus !== "certified") return false;
      if (status === "partially_supported" && skill.certificationStatus !== "partially_supported") return false;
      if (status === "blocked" && skill.certificationStatus !== "blocked" && skill.qualityStatus !== "disabled") return false;
      if (!needle) return true;
      const hay = [skill.name, skill.description, skill.category, skill.group, ...skill.tags, ...skill.triggers].join("\n").toLowerCase();
      return hay.includes(needle);
    });
    rows.sort((a, b) => {
      if (sort === "updated") return (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name);
      if (sort === "quality") return (b.qualityScore ?? -1) - (a.qualityScore ?? -1) || a.name.localeCompare(b.name);
      if (sort === "relevance") return (scores.get(b.id) ?? -1) - (scores.get(a.id) ?? -1) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    return rows;
  }, [skills, tab, group, source, status, query, sort, scores]);

  async function openQuality() {
    setQualityOpen(true);
    setQualityError(null);
    try {
      setQuality(await getJson<QualityView>("/skills/quality"));
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : "The quality report is unavailable.");
    }
  }

  async function toggleEnabled(skill: CatalogSkill, enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/skills/registry/${encodeURIComponent(skill.id)}`), {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not update the skill.");
      const next = body.skill as CatalogSkill | undefined;
      if (next) {
        setSkills((rows) => rows.map((row) => (row.id === skill.id ? { ...row, ...next } : row)));
        setDetail((current) => (current && current.id === skill.id ? { ...current, ...next } : current));
      }
      loadRoute();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the skill.");
    } finally {
      setSaving(false);
    }
  }

  const topScore = Math.max(0, ...(route?.selected ?? []).map((row) => row.score), ...(route?.additional ?? []).map((row) => row.score));

  return (
    <div className="ov-sk" data-testid="skills-workspace">
      <header className="ov-sk-top">
        <div>
          <h1>Skills & Intelligence</h1>
          <p>Discover, enable, and manage ORVYN&apos;s skills. ORION loads only the most relevant skills for each task.</p>
        </div>
        <div className="ov-sk-actions">
          <button type="button" className="ov-sk-btn" data-testid="open-quality-report" onClick={() => { if (qualityOpen) setQualityOpen(false); else void openQuality(); }}>
            {qualityOpen ? "Back to skills" : "Skill Quality Report"}
          </button>
          <button type="button" className="ov-sk-btn ov-sk-btn--primary" data-testid="import-skills" onClick={() => setImportOpen(true)}>Import Skills</button>
        </div>
      </header>

      {error && <div className="ov-sk-banner" role="alert">{error}</div>}

      {qualityOpen ? (
        <QualityReport report={quality} error={qualityError} />
      ) : (
        <>
          <section className="ov-sk-stats" aria-label="Skill counts">
            <Stat label="Total Skills" value={counts?.total} testId="skills-total" />
            <Stat label="Built-in" value={counts?.builtin} tone="cyan" hint="Native packages" />
            <Stat label="Imported" value={counts?.imported} hint="Certified imports included" />
            <Stat label="Approved" value={counts?.approved} tone="green" hint={counts ? `${counts.certified} certified` : undefined} />
            <Stat label="Needs Revision" value={counts?.needsRevision} tone="amber" hint={counts ? `${counts.partiallySupported} partially supported` : undefined} />
            <Stat label="Disabled" value={counts?.disabled} tone="red" hint={counts ? `${counts.blocked} blocked` : undefined} />
          </section>

          <div className="ov-sk-tabs" role="tablist">
            {TABS.map((item) => (
              <button key={item.id} type="button" role="tab" data-testid={`tab-${item.id}`} aria-selected={tab === item.id} className={tab === item.id ? "is-on" : ""} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>

          <div className="ov-sk-body">
            <aside className="ov-sk-cats" aria-label="Skill categories">
              <h2>Categories</h2>
              <button type="button" className={group === "All" ? "ov-sk-cat is-on" : "ov-sk-cat"} onClick={() => setGroup("All")}>
                All Categories <em>{counts?.total ?? ""}</em>
              </button>
              {categories.map((row) => (
                <button key={row.label} type="button" className={group === row.label ? "ov-sk-cat is-on" : "ov-sk-cat"} onClick={() => setGroup(row.label)}>
                  {row.label} <em>{row.count}</em>
                </button>
              ))}
            </aside>

            <section className="ov-sk-center">
              <RoutingSummary route={route} showRun={showRun} onToggleRun={() => setShowRun((value) => !value)} topScore={topScore} onOpen={setSelectedId} selectedId={selectedId} showExtra={showExtra} onToggleExtra={() => setShowExtra((value) => !value)} />

              <div className="ov-sk-filters">
                <input data-testid="skill-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills..." aria-label="Search skills" />
                <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="all">Status: All</option>
                  <option value="approved">Approved</option>
                  <option value="needs_revision">Needs Revision</option>
                  <option value="disabled">Disabled</option>
                  <option value="certified">Certified</option>
                  <option value="partially_supported">Partially Supported</option>
                  <option value="blocked">Blocked</option>
                </select>
                <select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value)}>
                  <option value="all">Source: All</option>
                  <option value="builtin">Built-in</option>
                  <option value="imported">Imported</option>
                </select>
                <select aria-label="Category" value={group} onChange={(event) => setGroup(event.target.value)}>
                  <option value="All">Category: All</option>
                  {categories.map((row) => <option key={row.label} value={row.label}>{row.label}</option>)}
                </select>
                <select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  <option value="relevance">Sort: Relevance</option>
                  <option value="name">Sort: Name</option>
                  <option value="used">Sort: Most Used</option>
                  <option value="updated">Sort: Recently Updated</option>
                  <option value="quality">Sort: Quality</option>
                </select>
              </div>
              {sort === "used" && <p className="ov-sk-note">Usage is not tracked, so Most Used follows name.</p>}
              {sort === "relevance" && !route && <p className="ov-sk-note">Relevance uses the latest skills.routed scores. None is recorded yet, so this order follows name.</p>}

              {loading ? <p className="ov-sk-loading">Loading the skill registry…</p> : (
                <SkillList skills={visible} selectedId={selectedId} onSelect={setSelectedId} />
              )}

              <EventLog events={events} />
            </section>

            <DetailPanel
              detail={detail}
              selectedId={selectedId}
              error={detailError}
              saving={saving}
              onToggle={toggleEnabled}
            />
          </div>
        </>
      )}

      {importOpen && (
        <div className="ov-sk-modal" role="presentation" onClick={() => setImportOpen(false)}>
          <div className="ov-sk-dialog" role="dialog" aria-labelledby="import-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="import-title">Import Skills</h2>
            <p>Compatible packages from the claude-skills import are already in this registry. ORVYN does not accept a skill upload from this screen. New packages are added by the skill importer, which certifies them before they can route.</p>
            <button type="button" className="ov-sk-btn ov-sk-btn--primary" onClick={() => setImportOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, hint, testId }: { label: string; value?: number; tone?: Tone; hint?: string; testId?: string }) {
  return (
    <article className={tone ? `ov-sk-stat ov-sk-stat--${tone}` : "ov-sk-stat"}>
      <b data-testid={testId}>{value == null ? "—" : value.toLocaleString()}</b>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </article>
  );
}

function SkillList({ skills, selectedId, onSelect }: { skills: CatalogSkill[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(640);
  const filterKey = `${skills.length}:${skills[0]?.id ?? ""}:${skills[skills.length - 1]?.id ?? ""}`;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setHeight(node.clientHeight || 640);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [filterKey]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
  const end = Math.min(skills.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 6);

  if (!skills.length) return <p className="ov-sk-none">No skills match these filters.</p>;

  return (
    <div className="ov-sk-list" ref={ref} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} data-testid="skill-list">
      <div style={{ height: skills.length * ROW_HEIGHT, position: "relative" }}>
        {skills.slice(start, end).map((skill, index) => (
          <div key={skill.id} style={{ position: "absolute", top: (start + index) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}>
            <button type="button" className={skill.id === selectedId ? "ov-sk-row is-on" : "ov-sk-row"} data-testid={`skill-row-${skill.id}`} onClick={() => onSelect(skill.id)}>
              <span className={skill.source === "builtin" ? "ov-sk-mark ov-sk-mark--builtin" : "ov-sk-mark"} aria-hidden="true">{skill.source === "builtin" ? "◆" : "☁"}</span>
              <span>
                <h3>{skill.name}</h3>
                <p>{skill.description}</p>
                <span className="ov-sk-meta">
                  {badges(skill).map((badge) => <i key={badge.label} className={`ov-sk-badge ov-sk-badge--${badge.tone}`}>{badge.label}</i>)}
                  <i className="ov-sk-chip">{skill.source === "builtin" ? "Built-in" : "Imported"}</i>
                  {skill.tags.slice(0, 3).map((tag) => <i key={tag} className="ov-sk-chip">{tag}</i>)}
                </span>
              </span>
              <span className="ov-sk-side">
                <b>v{skill.version || "—"}</b>
                {skill.enabled ? "Enabled" : "Disabled"}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoutingSummary({
  route, showRun, onToggleRun, topScore, onOpen, selectedId, showExtra, onToggleExtra,
}: {
  route: RouteSnapshot | null;
  showRun: boolean;
  onToggleRun: () => void;
  topScore: number;
  onOpen: (id: string) => void;
  selectedId: string | null;
  showExtra: boolean;
  onToggleExtra: () => void;
}) {
  return (
    <>
      <section className="ov-sk-route" data-testid="routing-summary">
        <header>
          <div>
            <div className="ov-sk-kicker">Routing</div>
            <h2>Routing Summary</h2>
          </div>
          <button type="button" className="ov-sk-btn" data-testid="view-last-run" disabled={!route} onClick={onToggleRun}>View Last Run</button>
        </header>
        {route ? (
          <div className="ov-sk-route-grid">
            <div className="ov-sk-metric ov-sk-metric--cyan"><b data-testid="routing-candidates">{route.candidateCount}</b><span>Candidate Skills</span></div>
            <div className="ov-sk-metric ov-sk-metric--green"><b data-testid="routing-selected">{route.selectedCount}</b><span>Selected for Model</span></div>
            <div className="ov-sk-metric ov-sk-metric--red"><b data-testid="routing-capability">{route.rejectedByCapabilityCount}</b><span>Rejected by Capability</span></div>
            <div className="ov-sk-metric ov-sk-metric--amber"><b data-testid="routing-score">{route.rejectedByScoreCount}</b><span>Rejected by Score / Policy</span></div>
          </div>
        ) : (
          <p className="ov-sk-empty">No skills.routed event yet. ORION records one when a task is routed. Counts stay empty until that event exists.</p>
        )}
        {route && showRun && (
          <div className="ov-sk-run" data-testid="last-run">
            <p><strong>{formatWhen(route.at)}</strong></p>
            <p>{route.instruction}</p>
            <p>{route.reasonSummary}</p>
            {route.rejectedByCapability.length > 0 && (
              <>
                <p>Rejected by capability</p>
                <ul>{route.rejectedByCapability.slice(0, 12).map((row) => <li key={row.id}>{row.name}: {row.reason}</li>)}</ul>
              </>
            )}
            {route.rejectedByScore.length > 0 && (
              <>
                <p>Rejected by score / policy</p>
                <ul>{route.rejectedByScore.slice(0, 12).map((row) => <li key={`${row.id}-${row.reason}`}>{row.name}: {row.reason}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </section>
      {route && route.selected.length > 0 && (
        <section className="ov-sk-matched">
          <header><h2>Top Matched Skills</h2><span className="ov-sk-chip">{route.selected.length} selected</span></header>
          <div className="ov-sk-match-list">
            {route.selected.map((row) => (
              <MatchRow key={row.id} row={row} topScore={topScore} active={row.id === selectedId} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}
      {route && route.additional.length > 0 && (
        <section className="ov-sk-matched">
          <header>
            <h2>Additional Relevant Skills</h2>
            <button type="button" className="ov-sk-btn" onClick={onToggleExtra}>{showExtra ? "Show fewer" : `View all (${route.additional.length})`}</button>
          </header>
          <div className="ov-sk-match-list">
            {(showExtra ? route.additional : route.additional.slice(0, 4)).map((row) => (
              <MatchRow key={row.id} row={row} topScore={topScore} active={row.id === selectedId} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function MatchRow({ row, topScore, active, onOpen }: { row: LoggedRank; topScore: number; active: boolean; onOpen: (id: string) => void }) {
  return (
    <button type="button" className={active ? "ov-sk-match is-on" : "ov-sk-match"} onClick={() => onOpen(row.id)}>
      <span>
        <strong>{row.name}</strong>
        <small>{row.selected ? "Selected" : "Not selected"} · {row.source === "builtin" ? "Built-in" : "Imported"} · {row.tags.slice(0, 3).join(" · ") || row.category || row.tier}</small>
      </span>
      <span className="ov-sk-score" title={`Router score ${row.score}`}>
        <b>{ratio(row.score, topScore)}</b>
        <span>score {row.score}</span>
      </span>
    </button>
  );
}

function EventLog({ events }: { events: SkillEvent[] }) {
  return (
    <section className="ov-sk-events" data-testid="event-log">
      <header><h2>Event Log</h2><span className="ov-sk-chip">{events.length}</span></header>
      {events.length === 0 ? <p className="ov-sk-empty">No skill events yet.</p> : events.slice(0, 8).map((event, index) => (
        <div className="ov-sk-event" key={`${event.at}-${event.type}-${index}`}>
          <code>{event.type}</code>
          <span>{event.detail}</span>
        </div>
      ))}
    </section>
  );
}

function DetailPanel({
  detail, selectedId, error, saving, onToggle,
}: {
  detail: SkillDetail | null;
  selectedId: string | null;
  error: string | null;
  saving: boolean;
  onToggle: (skill: CatalogSkill, enabled: boolean) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileInert, setFileInert] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    setTab("overview");
    setFilePath(null);
    setFileText(null);
    setFileInert(false);
    setFileError(null);
  }, [detail?.id]);

  async function openFile(file: SkillFile) {
    if (!detail) return;
    setFilePath(file.path);
    setFileText(null);
    setFileError(null);
    setFileInert(file.inert);
    try {
      const body = await getJson<{ content: string; inert: boolean; executable: boolean }>(`/skills/catalog/${encodeURIComponent(detail.id)}/file?path=${encodeURIComponent(file.path)}`);
      setFileText(body.content);
      setFileInert(body.inert || file.inert);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Could not read that file.");
    }
  }

  if (!selectedId) {
    return <aside className="ov-sk-detail"><p className="ov-sk-empty">Select a skill to see its metadata, tools, files, and provenance.</p></aside>;
  }
  if (!detail || detail.id !== selectedId) {
    if (error) return <aside className="ov-sk-detail"><p className="ov-sk-banner">{error}</p></aside>;
    return <aside className="ov-sk-detail"><p className="ov-sk-loading">Loading skill…</p></aside>;
  }

  const lock = lockedReason(detail);
  const subtabs: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "capabilities", label: "Capabilities" },
    { id: "files", label: "Files" },
    { id: "tools", label: "Tools" },
    { id: "related", label: "Related Skills" },
    { id: "history", label: "History" },
  ];

  return (
    <aside className="ov-sk-detail" data-testid="skill-detail">
      <div className="ov-sk-detail-head">
        <div>
          <h2 data-testid="skill-detail-name">{detail.name}</h2>
          <div className="ov-sk-meta" style={{ marginTop: 8 }}>
            {badges(detail).map((badge) => <i key={badge.label} className={`ov-sk-badge ov-sk-badge--${badge.tone}`}>{badge.label}</i>)}
          </div>
        </div>
        <label className="ov-sk-switch">
          {detail.enabled ? "Enabled" : "Disabled"}
          <button
            type="button"
            role="switch"
            aria-checked={detail.enabled}
            aria-label={lock ? lock : detail.enabled ? "Disable skill" : "Enable skill"}
            data-testid="skill-enabled"
            className={detail.enabled ? "is-on" : ""}
            disabled={Boolean(lock) || saving}
            title={lock ?? "Persists in skill preferences"}
            onClick={() => onToggle(detail, !detail.enabled)}
          >
            <i />
          </button>
        </label>
      </div>
      {lock && <p className="ov-sk-note">{lock} The router will not select it.</p>}

      <dl className="ov-sk-facts">
        <div><dt>Version</dt><dd>{detail.version || "Not recorded"}</dd></div>
        <div><dt>Source</dt><dd>{detail.source === "builtin" ? "Built-in" : "Imported"}</dd></div>
        <div><dt>Category</dt><dd>{detail.group}</dd></div>
        <div><dt>Publisher</dt><dd>{detail.publisher || "Not recorded"}</dd></div>
        <div><dt>Author</dt><dd>{detail.author || "Not recorded"}</dd></div>
        <div><dt>Last updated</dt><dd>{formatWhen(detail.updatedAt)}</dd></div>
        <div><dt>Usage count</dt><dd>Not tracked</dd></div>
        <div><dt>Success rate</dt><dd>Not tracked</dd></div>
      </dl>

      <div className="ov-sk-subtabs" role="tablist">
        {subtabs.map((item) => (
          <button key={item.id} type="button" data-testid={`detail-${item.id}`} className={tab === item.id ? "is-on" : ""} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <Block title="Description"><p>{detail.description || "No description in this package."}</p></Block>
          <Block title="When to use"><p>{detail.whenToUse || "This package has no separate when-to-use section."}</p></Block>
          <Block title="Triggers"><p>{detail.triggers.length ? detail.triggers.join(", ") : "No triggers recorded."}</p></Block>
          <Block title="Task domains"><p>{detail.taskDomains.length ? detail.taskDomains.join(", ") : "No task domains recorded."}</p></Block>
          <Block title="Run modes"><p>{detail.runModes.length ? detail.runModes.join(", ") : "No run modes recorded."}</p></Block>
          <Block title="Validation rule"><p>{detail.validationRule || "No validation rule recorded."}</p></Block>
          <Block title="Quality status"><p>{detail.qualityStatus || "No quality status in the report."}{detail.qualityScore != null ? ` · review score ${detail.qualityScore}` : ""}</p></Block>
          <Block title="Certification status"><p>{detail.certificationStatus || "No certification record."}</p></Block>
          <Block title="Provenance">
            {detail.origin ? (
              <div data-testid="provenance">
                <p data-testid="provenance-repository">origin.repository: {detail.origin.repository || "Not recorded"}</p>
                <p data-testid="provenance-path">origin.path: {detail.origin.path || "Not recorded"}</p>
                <p data-testid="provenance-author">origin.author: {detail.origin.author || "Not recorded"}</p>
                <p data-testid="provenance-license">origin.license: {detail.origin.license || "Not recorded"}</p>
                <p>origin.version: {detail.origin.version || "Not recorded"}</p>
              </div>
            ) : <p>Built-in package. No import origin is recorded.</p>}
          </Block>
        </>
      )}

      {tab === "capabilities" && (
        <>
          <Block title="Required tools"><ToolLines tools={detail.tools.required} empty="No required tools." /></Block>
          <Block title="Optional tools"><ToolLines tools={detail.tools.optional} empty="No optional tools." /></Block>
          <Block title="Permissions">
            {detail.permissions.length === 0 ? <p>No extra permissions recorded.</p> : detail.permissions.map((item) => <p key={item.id}>{item.id}: {item.reason}</p>)}
          </Block>
          <Block title="Execution requirements"><p>{detail.runModes.length ? detail.runModes.join(", ") : "No execution requirements recorded."}</p></Block>
        </>
      )}

      {tab === "files" && (
        <div data-testid="files-panel">
          {detail.files.length === 0 && <p>No package files were found.</p>}
          {detail.files.map((file) => (
            <button key={file.path} type="button" className={filePath === file.path ? "ov-sk-file is-on" : "ov-sk-file"} data-testid={file.path === "SKILL.md" ? "file-skill-md" : undefined} data-path={file.path} onClick={() => void openFile(file)}>
              {file.path} · {file.kind}{file.inert ? " · inert" : ""}
            </button>
          ))}
          {fileInert && <div className="ov-sk-inert" data-testid="script-inert">Inert / Not executable directly</div>}
          {fileError && <p className="ov-sk-banner">{fileError}</p>}
          {fileText != null && <pre className="ov-sk-pre" data-testid="file-content">{fileText}</pre>}
        </div>
      )}

      {tab === "tools" && (
        <>
          <Block title="Required Tools"><ToolMatrix tools={detail.tools.required} empty="None." /></Block>
          <Block title="Optional Tools"><ToolMatrix tools={detail.tools.optional} empty="None." /></Block>
          <Block title="Unresolved Tools"><ToolMatrix tools={detail.tools.unresolved} empty="None." /></Block>
        </>
      )}

      {tab === "related" && (
        <>
          <Block title="Related skills">
            {detail.related.length === 0 ? <p>No related skills are named by this package.</p> : detail.related.map((item) => <p key={item.id}>{item.name}{item.category ? ` · ${item.category}` : ""}</p>)}
          </Block>
          <Block title="Duplicate decisions">
            {detail.duplicates.length === 0 ? <p>No duplicate decision names this skill.</p> : detail.duplicates.map((item) => (
              <p key={`${item.decision}-${item.otherId}`}><strong>{item.decision}</strong> · {item.otherName}. {item.reason}</p>
            ))}
          </Block>
        </>
      )}

      {tab === "history" && (
        <Block title="History">
          <p>Usage history is not recorded. Times selected, recent runs, success and failure counts, and last used appear here when a run store records them.</p>
        </Block>
      )}
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="ov-sk-block"><h3>{title}</h3><div className="ov-sk-copy">{children}</div></section>;
}

function ToolLines({ tools, empty }: { tools: CatalogTool[]; empty: string }) {
  if (!tools.length) return <p>{empty}</p>;
  return <>{tools.map((tool) => <p key={tool.name}>{tool.name} · {tool.availability === "available" ? "Available" : tool.availability === "optional" ? "Optional" : "Unavailable"}</p>)}</>;
}

function ToolMatrix({ tools, empty }: { tools: CatalogTool[]; empty: string }) {
  if (!tools.length) return <p>{empty}</p>;
  return (
    <>
      {tools.map((tool) => (
        <div className="ov-sk-tool" key={`${tool.requirement}-${tool.name}`}>
          <strong>{tool.name}</strong>
          <span>{tool.registered ? "registered" : "not registered"} · {tool.permissionMapped ? "permission mapped" : "not permission mapped"} · {tool.available ? "available" : "not in this environment"}</span>
        </div>
      ))}
    </>
  );
}

function QualityReport({ report, error }: { report: QualityView | null; error: string | null }) {
  if (error) return <div className="ov-sk-report"><p className="ov-sk-banner">{error}</p></div>;
  if (!report) return <div className="ov-sk-report"><p className="ov-sk-loading">Loading the quality report…</p></div>;
  return (
    <div className="ov-sk-report" data-testid="quality-report">
      <h2 style={{ margin: 0 }}>Skill Quality Report</h2>
      <p className="ov-sk-empty">Generated {formatWhen(report.generatedAt)}. Counts are read from the current quality report.</p>
      <div className="ov-sk-report-stats">
        <Stat label="Checked" value={report.totalChecked} testId="quality-checked" />
        <Stat label="Approved" value={report.approved} tone="green" testId="quality-approved" />
        <Stat label="Needs Revision" value={report.needsRevision} tone="amber" testId="quality-revision" />
        <Stat label="Disabled" value={report.disabled} tone="red" testId="quality-disabled" />
      </div>
      <p className="ov-sk-empty">Native {report.native.approved} approved, {report.native.needsRevision} needs revision, {report.native.disabled} disabled. Imported {report.imported.approved} approved, {report.imported.needsRevision} needs revision, {report.imported.disabled} disabled.</p>
      <ReportList title="Broken References" empty="No broken references." rows={report.brokenReferences.map((item) => `${item.name}: ${item.paths.join(", ")}`)} />
      <ReportList title="Provider Wording" empty="No provider wording to adapt." rows={report.providerWording.map((item) => `${item.name}: ${item.changes} phrase${item.changes === 1 ? "" : "s"}`)} />
      <ReportList title="Unresolved Tool Assumptions" empty="No unresolved tool assumptions." rows={report.unresolvedToolAssumptions.map((item) => `${item.name}: ${item.detail}`)} />
      <ReportList title="Duplicate Decisions" empty="No duplicate decisions." rows={report.duplicates.map((item) => `${item.decision}: ${item.leftName} / ${item.rightName}. ${item.reason}`)} />
      <ReportList title="Disabled Skills" empty="No disabled skills." rows={report.disabledSkills.map((item) => `${item.name}: ${item.issues.map((issue) => issue.code).join(", ") || "disabled"}`)} />
      <ReportList title="Safety Findings" empty="No safety findings in the current report." rows={report.safetyViolations.map((item) => `${item.name} [${item.code}]: ${item.detail}`)} />
    </div>
  );
}

function ReportList({ title, rows, empty }: { title: string; rows: string[]; empty: string }) {
  return (
    <section className="ov-sk-section">
      <h3>{title} · {rows.length}</h3>
      {rows.length === 0 ? <p className="ov-sk-empty">{empty}</p> : <ul>{rows.map((row, index) => <li key={`${index}:${row}`}>{row}</li>)}</ul>}
    </section>
  );
}
