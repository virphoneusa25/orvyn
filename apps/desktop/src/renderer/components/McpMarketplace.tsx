// IDE-style MCP Marketplace: left detail + right discovery.
// Federation search / install / McpManager stay on the existing APIs.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig } from "../connection";
import {
  DETAIL_TABS,
  EMPTY_FILTERS,
  SIDEBAR_DEFAULT,
  SOURCE_LABEL,
  TOOL_BUDGET,
  applyFilters,
  clampSidebar,
  executionLocation,
  filterActiveCount,
  formatRisk,
  groupMarketplace,
  isConnected,
  isNeedsAuth,
  mergeInstalled,
  overlaySidebar,
  permissionSummary,
  pickSelectedServer,
  prettifyMarketName,
  primaryAction,
  sidebarForContainer,
  providerWarning,
  recommendServers,
  schemaArgNames,
  selectByOffset,
  serverLabel,
  DETAIL_MIN,
  tabAvailable,
  transportLabel,
  toolsAdvertisedLabel,
  uninstallCopy,
  toolOriginLabel,
  type DetailTab,
  type MarketFilters,
  type MarketServer,
  type MarketSource,
  type Recommendation,
  type UpdateRow,
} from "../mcpMarketplaceModel";
import { iconCandidates, parseApiJson, resolveMarketplaceIcon } from "../mcpMarketplaceIcons";
import {
  installPayload,
  isMarketplaceUnsupported,
  resolveMarketplaceCatalog,
  shouldUseHostInstall,
  type CatalogState,
} from "../mcpOfficialCatalog";
import {
  MARKETPLACE_DEBOUNCE_MS,
  degradedBanner,
  emptyKindFor,
  healthToProviders,
  mergeCatalogPreferIncoming,
  providerDots,
  shouldKeepPreviousResults,
  type ProviderStatusView,
} from "../mcpCatalogClient";

interface Health {
  id: string;
  name: string;
  status: string;
  detail?: string;
}

const CATEGORIES = [
  "Developer Tools",
  "Version Control",
  "Databases",
  "Cloud",
  "Automation",
  "Telecom",
  "Browser",
  "Email",
  "Communication",
];

export function McpMarketplace({
  projectRoot,
  initialQuery = "",
  onInstalled,
  capabilityBanner,
}: {
  projectRoot: string | null;
  initialQuery?: string;
  onInstalled?: () => void;
  capabilityBanner?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [results, setResults] = useState<MarketServer[]>([]);
  const [health, setHealth] = useState<Health[]>([]);
  const [providers, setProviders] = useState<Record<string, ProviderStatusView>>({});
  const [degraded, setDegraded] = useState<string[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [emptyKind, setEmptyKind] = useState<"results" | "true-empty" | "provider-failure" | "offline" | "auth-required">("results");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>("cloud");
  const searchGen = useRef(0);
  const resultsRef = useRef<MarketServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<MarketFilters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [tab, setTab] = useState<DetailTab>("details");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    installed: true,
    recommended: true,
    discover: true,
    updates: true,
    private: false,
  });
  const [sidebar, setSidebar] = useState(SIDEBAR_DEFAULT);
  const [viewport, setViewport] = useState(typeof window === "undefined" ? 1280 : window.innerWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const [wizard, setWizard] = useState<MarketServer | null>(null);
  const [settings, setSettings] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    setQ(initialQuery);
    setDebounced(initialQuery.trim());
  }, [initialQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), MARKETPLACE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const el = rootRef.current;
    const apply = () => setViewport(el?.clientWidth || window.innerWidth);
    apply();
    if (!el || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", apply);
      return () => window.removeEventListener("resize", apply);
    }
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const search = useCallback(async (query: string, opts?: { refresh?: boolean }) => {
    const mine = ++searchGen.current;
    setLoading(true);
    const backendUrl = getConnectionConfig().backendUrl;
    const previous = resultsRef.current;
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("limit", "48");
      if (filters.category) params.set("category", filters.category);
      if (opts?.refresh) params.set("refresh", "1");
      const skipMarket = isMarketplaceUnsupported(backendUrl);
      const fetchOne = async (url: string, timeoutMs: number) => {
        try {
          return await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: /aborted|timeout/i.test(String(err?.message)) ? "timeout" : String(err?.message ?? err) }), {
            status: 599,
            headers: { "content-type": "application/json" },
          });
        }
      };
      const [searchRes, healthRes, statusRes, updateRes] = await Promise.all([
        skipMarket
          ? Promise.resolve(new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } }))
          : fetchOne(apiUrl(`/mcp/marketplace/search?${params}`), 16_000),
        skipMarket ? Promise.resolve(new Response("{}", { status: 404 })) : fetchOne(apiUrl("/mcp/marketplace/health"), 8_000),
        fetchOne(apiUrl("/mcp/statuses"), 8_000),
        skipMarket ? Promise.resolve(new Response("{}", { status: 404 })) : fetchOne(apiUrl("/mcp/marketplace/updates"), 8_000),
      ]);
      if (mine !== searchGen.current) return;
      const searchText = await searchRes.text();
      const healthText = await healthRes.text().catch(() => "");
      const statusText = await statusRes.text().catch(() => "");
      const updateText = await updateRes.text().catch(() => "");
      if (mine !== searchGen.current) return;
      const healthParsed = parseApiJson(healthRes.status, healthText, healthRes.headers.get("content-type") ?? undefined);
      const statusParsed = parseApiJson(statusRes.status, statusText, statusRes.headers.get("content-type") ?? undefined);
      const updateParsed = parseApiJson(updateRes.status, updateText, updateRes.headers.get("content-type") ?? undefined);
      const resolved = await resolveMarketplaceCatalog({
        status: searchRes.status,
        text: searchText,
        contentType: searchRes.headers.get("content-type") ?? undefined,
        query,
        backendUrl,
        previousCatalog: previous,
      });
      if (mine !== searchGen.current) return;
      const statuses = statusParsed.ok ? (statusParsed.body.servers ?? []) : [];
      const mergedCatalog = mergeInstalled(resolved.catalog, statuses);
      const providerMap = healthToProviders(
        (resolved.parsed.ok && resolved.parsed.body?.health) || healthParsed.body.providers || []
      );
      const kind = emptyKindFor({
        resultCount: mergedCatalog.length,
        fromCache: Boolean(resolved.fromCache || resolved.parsed.body?.fromCache),
        providers: Object.keys(providerMap).length ? providerMap : { official: { status: resolved.state === "degraded" ? "slow" : "online" } },
        catalogState: resolved.state,
      });
      const keep = shouldKeepPreviousResults({ incomingCount: mergedCatalog.length, emptyKind: kind, hadResults: previous.length > 0 });
      const next = mergeCatalogPreferIncoming(previous, mergedCatalog, keep);
      const banner = resolved.notice || degradedBanner(providerMap, Boolean(resolved.fromCache));
      setCatalogState(resolved.state);
      setFromCache(Boolean(resolved.fromCache || resolved.parsed.body?.fromCache));
      setEmptyKind(kind);
      setProviders(providerMap);
      setError(resolved.state === "auth-required" ? (resolved.error ?? "Cloud account/session requires attention") : null);
      resultsRef.current = next;
      setResults(next);
      setHealth(healthParsed.body.providers ?? []);
      setDegraded(banner ? [banner] : providerWarning(healthParsed.body.providers ?? []));
      setUpdates(updateParsed.body.updates ?? []);
    } catch (err: any) {
      if (mine !== searchGen.current) return;
      setCatalogState("degraded");
      setEmptyKind(previous.length ? "provider-failure" : "offline");
      setDegraded(["Some registries are unavailable"]);
      setError(null);
    } finally {
      if (mine === searchGen.current) setLoading(false);
    }
  }, [filters.category]);

  useEffect(() => {
    void search(debounced);
  }, [debounced, search]);

  const updateIds = useMemo(() => new Set(updates.map((u) => u.serverId)), [updates]);
  const filtered = useMemo(() => applyFilters(results, filters, updateIds), [results, filters, updateIds]);
  const recommended = useMemo(
    () => recommendServers(filtered, { query: debounced || capabilityBanner || initialQuery, projectHints: projectRoot ? [projectRoot] : [] }),
    [filtered, debounced, capabilityBanner, initialQuery, projectRoot]
  );
  const groups = useMemo(() => groupMarketplace(filtered, updates, recommended), [filtered, updates, recommended]);
  const selected = pickSelectedServer(filtered, recommended, selectedId);

  useEffect(() => {
    if (selected && selected.canonicalId !== selectedId) setSelectedId(selected.canonicalId);
  }, [selected, selectedId]);

  useEffect(() => {
    setExpandedTool(null);
    setMenuOpen(false);
    const update = updates.find((u) => u.serverId === selected?.installed?.serverId);
    if (selected && !tabAvailable(tab, selected, update?.changelog)) setTab("details");
  }, [selected?.canonicalId]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    if (openSections.installed) ids.push(...groups.installed.map((s) => s.canonicalId));
    if (openSections.recommended) ids.push(...groups.recommended.map((r) => r.server.canonicalId));
    if (openSections.discover) ids.push(...groups.discover.map((s) => s.canonicalId));
    return [...new Set(ids)];
  }, [groups, openSections]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        setFilterOpen(false);
        setWizard(null);
        setSettings(false);
        setConfirmUninstall(false);
        setOverflow(false);
        setMenuOpen(false);
        if (overlaySidebar(viewport)) setBrowseOpen(false);
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = selectByOffset(visibleIds, selected?.canonicalId ?? null, e.key === "ArrowDown" ? 1 : -1);
        if (next) setSelectedId(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleIds, selected, viewport]);

  async function install(server: MarketServer, secrets?: Record<string, string>) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/mcp/marketplace/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ server, secrets, connect: true, cwd: projectRoot }),
      });
      const text = await res.text();
      const parsed = parseApiJson(res.status, text, res.headers.get("content-type") ?? undefined);
      if (!parsed.ok && shouldUseHostInstall(parsed, res.status)) {
        const host = await fetch(apiUrl("/mcp/servers"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(installPayload(server, secrets)),
        });
        const hostText = await host.text();
        const hostParsed = parseApiJson(host.status, hostText, host.headers.get("content-type") ?? undefined);
        if (!hostParsed.ok) throw new Error(hostParsed.error || parsed.error || "Install failed");
        const createdId = hostParsed.body?.server?.id;
        if (createdId) {
          await fetch(apiUrl(`/mcp/servers/${createdId}/connect`), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
          }).catch(() => undefined);
        }
      } else if (!parsed.ok) {
        throw new Error(parsed.error || "Install failed");
      }
      onInstalled?.();
      await search(debounced);
      setWizard(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function serverAction(id: string, action: "connect" | "disconnect" | "reconnect") {
    setBusy(true);
    try {
      await fetch(apiUrl(`/mcp/servers/${id}/${action}`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
      await search(debounced);
      onInstalled?.();
    } finally {
      setBusy(false);
    }
  }

  async function connectOAuth(id: string) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/mcp/oauth/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ serverId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OAuth start failed");
      if (data.authorizeUrl && window.orvyn?.window?.openExternal) await window.orvyn.window.openExternal(data.authorizeUrl);
      else if (data.authorizeUrl) window.open(data.authorizeUrl, "_blank", "noopener");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
      void search(debounced);
    }
  }

  async function uninstall(id: string) {
    setBusy(true);
    try {
      await fetch(apiUrl(`/mcp/servers/${id}`), { method: "DELETE", headers: authHeaders() });
      setConfirmUninstall(false);
      onInstalled?.();
      await search(debounced);
    } finally {
      setBusy(false);
    }
  }

  async function setScope(id: string, scope: "global" | "project" | "run") {
    await fetch(apiUrl(`/mcp/servers/${id}/scope`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ scope, cwd: projectRoot }),
    });
    void search(debounced);
  }

  async function setToolPermission(serverId: string, tool: string, mode: "ALLOW" | "ASK" | "DENY") {
    await fetch(apiUrl(`/mcp/servers/${serverId}/permissions/tool`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tool, mode }),
    });
    void search(debounced);
  }

  function runPrimary(server: MarketServer) {
    const hasUpdate = Boolean(server.installed && updateIds.has(server.installed.serverId));
    const action = primaryAction(server, hasUpdate);
    if (action.kind === "install") setWizard(server);
    else if (action.kind === "connect") {
      if (server.auth.some((a) => a.kind === "oauth") && server.installed) void connectOAuth(server.installed.serverId);
      else setWizard(server);
    } else if (action.kind === "disable" && server.installed) void serverAction(server.installed.serverId, "disconnect");
    else if (action.kind === "enable" && server.installed) void serverAction(server.installed.serverId, "connect");
    else if (action.kind === "connected" && server.installed) void serverAction(server.installed.serverId, "reconnect");
  }

  const overlay = overlaySidebar(viewport);
  const listWidth = overlay ? undefined : sidebarForContainer(viewport, sidebar);
  const warnings = degraded.length ? degraded : providerWarning(health);
  const recReason = (id: string) => recommended.find((r) => r.server.canonicalId === id)?.reason;

  function onDividerDown(e: React.MouseEvent) {
    if (overlay) return;
    drag.current = { startX: e.clientX, startW: sidebar };
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      setSidebar(clampSidebar(drag.current.startW + (drag.current.startX - ev.clientX)));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <div
      ref={rootRef}
      data-testid="mcp-marketplace"
      data-layout={overlay ? "overlay" : "split"}
      style={{
        display: overlay ? "flex" : "grid",
        gridTemplateColumns: overlay ? undefined : `minmax(${DETAIL_MIN}px, 1fr) 5px ${listWidth}px`,
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        background: "var(--orvyn-bg, #0B0E14)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <section
        style={{
          flex: overlay ? 1 : undefined,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRight: overlay ? "none" : "1px solid var(--orvyn-border-soft)",
        }}
      >
        {overlay && (
          <div style={{ position: "absolute", right: 16, top: 16, zIndex: 5 }}>
            <button style={ghostBtn} onClick={() => setBrowseOpen(true)}>Browse marketplace</button>
          </div>
        )}
        {selected ? (
          <DetailPane
            server={selected}
            tab={tab}
            onTab={setTab}
            busy={busy}
            updates={updates}
            expandedTool={expandedTool}
            onExpandTool={setExpandedTool}
            onPrimary={() => runPrimary(selected)}
            onSettings={() => { setSettings(true); setTab("configuration"); }}
            onUninstall={() => setConfirmUninstall(true)}
            onMenu={() => setMenuOpen((v) => !v)}
            menuOpen={menuOpen}
            hasUpdate={Boolean(selected.installed && updateIds.has(selected.installed.serverId))}
            onToolMode={selected.installed ? (tool, mode) => void setToolPermission(selected.installed!.serverId, tool, mode) : undefined}
            onScope={selected.installed ? (scope) => void setScope(selected.installed!.serverId, scope) : undefined}
            banner={capabilityBanner || (debounced && recReason(selected.canonicalId)) || undefined}
          />
        ) : (
          <EmptyDetail loading={loading} query={debounced} />
        )}
      </section>

      {!overlay && <div onMouseDown={onDividerDown} style={{ width: 5, cursor: "col-resize", background: "transparent" }} title="Resize marketplace" />}

      {overlay && browseOpen && <div onClick={() => setBrowseOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 15 }} />}

      <aside
        style={{
          width: overlay ? "min(92vw, 420px)" : "100%",
          minWidth: 0,
          minHeight: 0,
          position: overlay ? "absolute" : "relative",
          right: 0,
          top: 0,
          bottom: overlay ? 0 : undefined,
          zIndex: overlay ? 20 : 1,
          display: overlay && !browseOpen ? "none" : "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--orvyn-surface-1, #10141E)",
          borderLeft: overlay ? "1px solid var(--orvyn-border-soft)" : "none",
          boxShadow: overlay ? "var(--orvyn-shadow)" : "none",
        }}
      >
        <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-0.01em" }}>MCP Marketplace</div>
            {overlay && (
              <button style={{ ...ghostBtn, marginLeft: "auto", padding: "2px 8px" }} onClick={() => setBrowseOpen(false)}>Close</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search MCP servers, tools, or capabilities..."
              style={searchInput}
            />
            <IconBtn title="Refresh" onClick={() => void search(debounced, { refresh: true })}>↻</IconBtn>
            <IconBtn title="Filters" onClick={() => setFilterOpen((v) => !v)} active={filterActiveCount(filters) > 0}>
              ▦{filterActiveCount(filters) ? ` ${filterActiveCount(filters)}` : ""}
            </IconBtn>
            <IconBtn title="More" onClick={() => setOverflow((v) => !v)}>⋯</IconBtn>
          </div>
          <ProviderDots providers={providers} />
          {catalogState === "official-fallback" && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-cyan, #22D3EE)", marginTop: 8 }}>
              Cloud catalog unavailable · showing Official Registry results
            </div>
          )}
          {warnings.length > 0 && catalogState !== "official-fallback" && (
            <div data-testid="marketplace-degraded" style={{ fontSize: 10.5, color: "var(--orvyn-yellow, #E9B44C)", marginTop: 8 }}>{warnings[0]}</div>
          )}
          {error && catalogState === "auth-required" && (
            <div style={{ fontSize: 11, color: "var(--orvyn-yellow, #E9B44C)", marginTop: 6 }}>{error}</div>
          )}
          {fromCache && emptyKind === "offline" && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-yellow, #E9B44C)", marginTop: 6 }}>Offline · showing cached catalog</div>
          )}
        </div>

        {filterOpen && (
          <FilterPopover
            filters={filters}
            onChange={setFilters}
            onClose={() => setFilterOpen(false)}
          />
        )}
        {overflow && (
          <OverflowMenu
            onAddServer={() => document.dispatchEvent(new CustomEvent("orvyn:mcp-add-server"))}
            onAddRegistry={() => setOpenSections((s) => ({ ...s, private: true }))}
            onClose={() => setOverflow(false)}
          />
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 0 16px" }}>
          {loading && !results.length && <SkeletonList />}
          <Section
            title="Installed"
            count={groups.installed.length}
            open={openSections.installed}
            onToggle={() => setOpenSections((s) => ({ ...s, installed: !s.installed }))}
          >
            {groups.installed.map((s) => (
              <ServerRow key={s.canonicalId} server={s} selected={s.canonicalId === selected?.canonicalId} onSelect={() => setSelectedId(s.canonicalId)} onAction={() => runPrimary(s)} busy={busy} />
            ))}
          </Section>
          <Section
            title="Recommended"
            count={groups.recommended.length}
            open={openSections.recommended}
            onToggle={() => setOpenSections((s) => ({ ...s, recommended: !s.recommended }))}
          >
            {groups.recommended.map((r) => (
              <ServerRow key={r.server.canonicalId} server={r.server} selected={r.server.canonicalId === selected?.canonicalId} onSelect={() => setSelectedId(r.server.canonicalId)} onAction={() => runPrimary(r.server)} busy={busy} reason={r.reason} />
            ))}
          </Section>
          <Section
            title="Discover"
            count={groups.discover.length}
            open={openSections.discover}
            onToggle={() => setOpenSections((s) => ({ ...s, discover: !s.discover }))}
          >
            {groups.discover.map((s) => (
              <ServerRow key={s.canonicalId} server={s} selected={s.canonicalId === selected?.canonicalId} onSelect={() => setSelectedId(s.canonicalId)} onAction={() => runPrimary(s)} busy={busy} />
            ))}
          </Section>
          <Section
            title="Updates"
            count={groups.updates.length}
            open={openSections.updates}
            onToggle={() => setOpenSections((s) => ({ ...s, updates: !s.updates }))}
          >
            {groups.updates.map((u) => (
              <div key={u.serverId} style={{ padding: "8px 12px", fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{u.name}</div>
                <div style={{ color: "var(--orvyn-text-muted)", fontSize: 11 }}>Current pin {u.current}{u.available ? ` → ${u.available}` : ""}</div>
              </div>
            ))}
          </Section>
          {groups.private.length > 0 && (
            <Section title="Private" count={groups.private.length} open={openSections.private} onToggle={() => setOpenSections((s) => ({ ...s, private: !s.private }))}>
              {groups.private.map((s) => (
                <ServerRow key={s.canonicalId} server={s} selected={s.canonicalId === selected?.canonicalId} onSelect={() => setSelectedId(s.canonicalId)} onAction={() => runPrimary(s)} busy={busy} />
              ))}
            </Section>
          )}
          {openSections.private && (
            <div style={{ padding: "8px 12px 16px" }}>
              <PrivateRegistries onSaved={() => void search(debounced)} />
            </div>
          )}
          {!loading && filtered.length === 0 && emptyKind === "true-empty" && (
            <div style={{ padding: 18, fontSize: 12.5, color: "var(--orvyn-text-muted)" }}>
              <div style={{ fontWeight: 600, color: "var(--orvyn-text)", marginBottom: 6 }}>No MCP servers found</div>
              Try another search or add a custom server.
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button style={ghostBtn} onClick={() => document.dispatchEvent(new CustomEvent("orvyn:mcp-add-server"))}>Add Server</button>
                <button style={ghostBtn} onClick={() => setOpenSections((s) => ({ ...s, private: true }))}>Add Registry</button>
              </div>
            </div>
          )}
          {!loading && filtered.length === 0 && emptyKind !== "true-empty" && emptyKind !== "results" && (
            <div style={{ padding: 18, fontSize: 12.5, color: "var(--orvyn-text-muted)" }}>
              <div style={{ fontWeight: 600, color: "var(--orvyn-text)", marginBottom: 6 }}>
                {emptyKind === "offline" ? "Marketplace is temporarily offline." : "Some registries are unavailable"}
              </div>
              Installed MCP servers stay visible. Cached catalog results are shown when we have them.
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button style={ghostBtn} onClick={() => void search(debounced, { refresh: true })}>Retry</button>
                <button style={ghostBtn} onClick={() => document.dispatchEvent(new CustomEvent("orvyn:mcp-add-server"))}>Add Server</button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {wizard && (
        <InstallDrawer server={wizard} busy={busy} onClose={() => setWizard(null)} onInstall={(secrets) => void install(wizard, secrets)} />
      )}
      {settings && selected && (
        <SettingsDrawer
          server={selected}
          onClose={() => setSettings(false)}
          onScope={selected.installed ? (scope) => void setScope(selected.installed!.serverId, scope) : undefined}
          onConnect={() => selected.installed && void connectOAuth(selected.installed.serverId)}
        />
      )}
      {confirmUninstall && selected?.installed && (
        <ConfirmDialog
          title={`Uninstall ${serverLabel(selected)}`}
          body={uninstallCopy(selected)}
          confirm="Uninstall"
          onCancel={() => setConfirmUninstall(false)}
          onConfirm={() => void uninstall(selected.installed!.serverId)}
        />
      )}
    </div>
  );
}

function DetailPane({
  server,
  tab,
  onTab,
  busy,
  updates,
  expandedTool,
  onExpandTool,
  onPrimary,
  onSettings,
  onUninstall,
  onMenu,
  menuOpen,
  hasUpdate,
  onToolMode,
  onScope,
  banner,
}: {
  server: MarketServer;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  busy: boolean;
  updates: UpdateRow[];
  expandedTool: string | null;
  onExpandTool: (name: string | null) => void;
  onPrimary: () => void;
  onSettings: () => void;
  onUninstall: () => void;
  onMenu: () => void;
  menuOpen: boolean;
  hasUpdate: boolean;
  onToolMode?: (tool: string, mode: "ALLOW" | "ASK" | "DENY") => void;
  onScope?: (scope: "global" | "project" | "run") => void;
  banner?: string;
}) {
  const action = primaryAction(server, hasUpdate);
  const update = updates.find((u) => u.serverId === server.installed?.serverId);
  const loc = executionLocation(server);
  const tools = server.tools ?? [];
  const active = tools.filter((t) => t.active).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <header style={{ padding: "22px 28px 0", flexShrink: 0 }}>
        {banner && (
          <div style={{ fontSize: 12, color: "var(--orvyn-cyan, #22D3EE)", background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 14 }}>
            {banner}
          </div>
        )}
        <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
          <ServerGlyph key={server.canonicalId} server={server} size={56} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              title={server.title || server.name}
              style={{
                fontSize: 22,
                fontWeight: 650,
                letterSpacing: "-0.02em",
                lineHeight: 1.25,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflowWrap: "break-word",
                wordBreak: "normal",
                hyphens: "none",
              }}
            >
              {serverLabel(server)}
            </div>
            <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", marginTop: 6 }}>
              {server.publisher ?? prettifyMarketName(server.name.split("/").pop() ?? server.name)}
              {" · "}
              {server.sources.map((s) => SOURCE_LABEL[s]).join(" · ")}
              {server.sources.includes("private") ? " · Organization Approved" : ""}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--orvyn-text-secondary)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
              {toolsAdvertisedLabel(server)} · {transportLabel(server)} · {loc === "local" ? "Local Only" : "Remote"}
              {server.installed ? ` · ${server.installed.state}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", position: "relative" }}>
            <button disabled={busy || action.kind === "connected"} onClick={onPrimary} style={action.kind === "connected" ? ghostBtn : primaryBtn}>
              {busy ? "…" : action.label}
            </button>
            {server.installed && (
              <button onClick={onMenu} style={ghostBtn}>{server.installed.enabled === false ? "Enable" : "Uninstall"} ▾</button>
            )}
            <IconBtn title="Server settings" onClick={onSettings}>⚙</IconBtn>
            {menuOpen && server.installed && (
              <div style={menuBox}>
                {server.installed.enabled !== false && <button style={menuItem} onClick={() => { onPrimary(); }}>Disable</button>}
                <button style={{ ...menuItem, color: "var(--orvyn-red, #F25F75)" }} onClick={onUninstall}>Uninstall…</button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 18, borderBottom: "1px solid var(--orvyn-border-soft)", overflowX: "auto", flexWrap: "nowrap" }}>
          {DETAIL_TABS.filter((t) => tabAvailable(t.id, server, update?.changelog)).map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              style={{
                background: "none",
                border: "none",
                borderBottom: tab === t.id ? "2px solid var(--orvyn-cyan, #22D3EE)" : "2px solid transparent",
                color: tab === t.id ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
                fontSize: 11,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                padding: "8px 0",
                cursor: "pointer",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 40px" }}>
        {tab === "details" && <DetailsTab server={server} />}
        {tab === "tools" && (
          <ToolsTab
            server={server}
            expanded={expandedTool}
            onExpand={onExpandTool}
            onMode={onToolMode}
            activeCount={active}
          />
        )}
        {tab === "permissions" && <PermissionsTab server={server} />}
        {tab === "configuration" && <ConfigurationTab server={server} onScope={onScope} />}
        {tab === "security" && <SecurityTab server={server} />}
        {tab === "source" && <SourceTab server={server} />}
        {tab === "changelog" && <ChangelogTab server={server} notes={update?.changelog} current={update?.current} available={update?.available} />}
      </div>
    </div>
  );
}

function DetailsTab({ server }: { server: MarketServer }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={h2}>{serverLabel(server)}</h2>
      <p style={body}>{server.description}</p>
      <h3 style={h3}>Overview</h3>
      <p style={body}>
        {toolsAdvertisedLabel(server)} · {transportLabel(server)} · {executionLocation(server) === "local" ? "runs on this desktop (Local Only from OVH)" : "cloud-reachable Streamable HTTP"}.
        ORION discovers tools with search_capabilities and activates at most {TOOL_BUDGET.maxServers} servers / {TOOL_BUDGET.maxTools} tools.
      </p>
      {!!server.categories.length && (
        <>
          <h3 style={h3}>Capabilities</h3>
          <p style={body}>{server.categories.join(" · ")}</p>
        </>
      )}
      <h3 style={h3}>Authentication</h3>
      <p style={body}>{server.auth.map((a) => a.label || a.kind).join(", ") || "None advertised"}</p>
      <h3 style={h3}>Registry sources</h3>
      <p style={body}>{server.sources.map((s) => SOURCE_LABEL[s]).join(", ")}</p>
    </div>
  );
}

function ToolsTab({
  server,
  expanded,
  onExpand,
  onMode,
  activeCount,
}: {
  server: MarketServer;
  expanded: string | null;
  onExpand: (name: string | null) => void;
  onMode?: (tool: string, mode: "ALLOW" | "ASK" | "DENY") => void;
  activeCount: number;
}) {
  const tools = server.tools ?? [];
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--orvyn-text-muted)", marginBottom: 12 }}>
        {toolsAdvertisedLabel(server)}
        {server.installed ? ` · ${activeCount} currently active in ORION` : " · none active until connected"}
        {` · budget ${TOOL_BUDGET.maxServers}/${TOOL_BUDGET.maxTools}`}
      </div>
      {tools.length === 0 && <div style={body}>No tools/list payload yet. Connect the server to introspect live tools.</div>}
      {tools.map((t) => (
        <div key={t.name} style={{ borderBottom: "1px solid var(--orvyn-border-soft)" }}>
          <button
            onClick={() => onExpand(expanded === t.name ? null : t.name)}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", color: "inherit", padding: "10px 0", cursor: "pointer", display: "flex", gap: 12, alignItems: "center" }}
          >
            <code style={{ fontSize: 13, minWidth: 180 }}>{t.name}</code>
            <span style={{ flex: 1, fontSize: 13, color: "var(--orvyn-text-secondary)" }}>{t.description}</span>
            <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>{toolOriginLabel(t, Boolean(server.installed))}</span>
            <span style={{ fontSize: 10, letterSpacing: 0.4, color: /read/i.test(t.risk) ? "var(--orvyn-cyan)" : /destruc/i.test(t.risk) ? "var(--orvyn-red)" : "var(--orvyn-yellow)" }}>{formatRisk(t.risk)}</span>
            {t.active && <span style={{ ...badge, color: "var(--orvyn-green, #20D89B)" }}>Active</span>}
          </button>
          {expanded === t.name && (
            <div style={{ padding: "0 0 12px 8px", fontSize: 12.5, color: "var(--orvyn-text-secondary)" }}>
              <div>{t.description || "No description."}</div>
              <div style={{ marginTop: 6, color: "var(--orvyn-text-muted)" }}>
                {formatRisk(t.risk)}. Write/destructive tools stay on Ask unless you change the override.
                {schemaArgNames(t.inputSchema).length ? ` Arguments: ${schemaArgNames(t.inputSchema).join(", ")}.` : " Argument schema is listed after connect when tools/list provides it."}
              </div>
              {onMode && (
                <select
                  value={t.permission ?? "ASK"}
                  onChange={(e) => onMode(t.name, e.target.value as "ALLOW" | "ASK" | "DENY")}
                  style={{ marginTop: 8, background: "transparent", color: "var(--orvyn-text-secondary)", border: "1px solid var(--orvyn-border)", borderRadius: 4, fontSize: 11, padding: "2px 6px" }}
                >
                  <option value="ALLOW">Allow</option>
                  <option value="ASK">Ask</option>
                  <option value="DENY">Disable tool</option>
                </select>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PermissionsTab({ server }: { server: MarketServer }) {
  const p = permissionSummary(server);
  return (
    <div style={{ maxWidth: 640 }}>
      <h3 style={h3}>This MCP server can</h3>
      {p.can.map((x) => <div key={x} style={body}>✓ {x}</div>)}
      <h3 style={{ ...h3, marginTop: 22 }}>This MCP server may</h3>
      {p.may.map((x) => <div key={x} style={body}>⚠ {x}</div>)}
      <p style={{ ...body, color: "var(--orvyn-text-muted)" }}>Full Access cannot bypass admin hard deny. Ask mode still prompts for write tools.</p>
    </div>
  );
}

function ConfigurationTab({ server, onScope }: { server: MarketServer; onScope?: (s: "global" | "project" | "run") => void }) {
  const http = server.transports.find((t) => t.kind === "http");
  const stdio = server.transports.find((t) => t.kind === "stdio");
  const scope = server.installed?.scope ?? "global";
  return (
    <div style={{ maxWidth: 640 }}>
      <Meta row="Scope" value={scope === "project" ? "This Project" : scope === "run" ? "This Run" : "Global"} />
      {onScope && (
        <div style={{ display: "flex", gap: 8, margin: "8px 0 14px" }}>
          {(["global", "project", "run"] as const).map((s) => (
            <button
              key={s}
              style={{
                ...ghostBtn,
                borderColor: scope === s ? "var(--orvyn-cyan, #22D3EE)" : "var(--orvyn-border)",
                color: scope === s ? "var(--orvyn-text)" : "var(--orvyn-text-secondary)",
              }}
              onClick={() => onScope(s)}
            >
              {s === "global" ? "Global" : s === "project" ? "This Project" : "This Run"}
            </button>
          ))}
        </div>
      )}
      <Meta row="Execution" value={executionLocation(server) === "local" ? "Local Only" : "Remote"} />
      <Meta row="Transport" value={transportLabel(server)} />
      <Meta row="Endpoint" value={http?.url ?? stdio?.command ?? "—"} />
      <Meta row="Command" value={stdio ? [stdio.command, ...(stdio.args ?? [])].join(" ") : "—"} />
      <Meta row="Secret refs" value={server.auth.length ? server.auth.map((a) => a.kind).join(", ") + " (values never shown)" : "none"} />
    </div>
  );
}

function SecurityTab({ server }: { server: MarketServer }) {
  const pkg = server.packages?.[0];
  return (
    <div style={{ maxWidth: 640 }}>
      <Meta row="Trust" value={`${server.trust.level} — ${server.trust.reasons.join("; ") || "no extra checks"}`} />
      <Meta row="Registry" value={server.sources.map((s) => SOURCE_LABEL[s]).join(", ")} />
      <Meta row="Publisher" value={server.publisher ?? "—"} />
      <Meta row="Package" value={pkg ? `${pkg.identifier}${pkg.version ? `@${pkg.version}` : ""}` : server.version ?? "—"} />
      <Meta row="Integrity" value={pkg?.integrity ?? server.provenance?.integrity ?? "not published"} />
      <Meta row="Install scripts" value={server.provenance?.scripts?.length ? server.provenance.scripts.join(", ") : "none advertised"} />
      <Meta row="Network" value={server.networkRequired || executionLocation(server) === "remote" ? "Required" : "Not advertised"} />
      <Meta row="Filesystem" value={server.filesystemScope ?? "none"} />
      <Meta row="Verification" value={server.trust.level === "verified" ? "ORVYN Verified" : server.trust.level} />
      <Meta
        row="Last check"
        value={
          server.installed?.lastError
            ? server.installed.lastError
            : server.installed?.lastConnectedAt
              ? new Date(server.installed.lastConnectedAt).toLocaleString()
              : server.installed
                ? server.installed.state
                : "not installed"
        }
      />
    </div>
  );
}

function ChangelogTab({ server, notes, current, available }: { server: MarketServer; notes?: string; current?: string; available?: string | null }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={h2}>{serverLabel(server)}</h2>
      <p style={body}>
        Current pin {current ?? server.version ?? "unknown"}
        {available ? ` · available ${available}` : ""}
      </p>
      <p style={body}>{notes}</p>
    </div>
  );
}

function SourceTab({ server }: { server: MarketServer }) {
  return (
    <div style={{ maxWidth: 640 }}>
      <Meta row="Official" value={server.sources.includes("official") ? "Listed on the Official MCP Registry" : "Not from Official"} />
      <Meta row="Glama" value={server.sources.includes("glama") ? "Also listed on Glama" : "—"} />
      <Meta row="Smithery" value={server.sources.includes("smithery") ? "Also listed on Smithery" : "—"} />
      <Meta row="Repository" value={server.repository ?? "—"} />
      <Meta row="Homepage" value={server.homepage ?? "—"} />
      <Meta row="Package" value={server.packages?.[0]?.identifier ?? "—"} />
      {server.repository?.startsWith("http") && (
        <a href={server.repository} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "var(--orvyn-cyan, #22D3EE)" }}>Open repository</a>
      )}
    </div>
  );
}

function ServerRow({
  server,
  selected,
  onSelect,
  onAction,
  busy,
  reason,
}: {
  server: MarketServer;
  selected: boolean;
  onSelect: () => void;
  onAction: () => void;
  busy: boolean;
  reason?: string;
}) {
  const action = primaryAction(server);
  const dot =
    !server.installed ? "transparent" :
    isConnected(server) ? "var(--orvyn-green, #20D89B)" :
    isNeedsAuth(server) ? "var(--orvyn-yellow, #F5B942)" :
    server.installed.state === "ERROR" ? "var(--orvyn-red, #F25F75)" :
    "var(--orvyn-text-muted)";
  return (
    <div
      title={reason}
      onClick={onSelect}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "8px 12px",
        cursor: "pointer",
        background: selected ? "rgba(77,163,255,0.12)" : "transparent",
        borderLeft: selected ? "2px solid var(--orvyn-cyan, #22D3EE)" : "2px solid transparent",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <ServerGlyph key={server.canonicalId} server={server} size={36} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{serverLabel(server)}</div>
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {server.description}
        </div>
        <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)", marginTop: 2 }}>
          {server.sources.map((s) => SOURCE_LABEL[s]).join(" · ")}
          {` · ${toolsAdvertisedLabel(server)}`}
          {` · ${server.trust.level}`}
        </div>
      </div>
      <button
        disabled={busy || action.kind === "connected"}
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        style={{ ...ghostBtn, padding: "4px 8px", fontSize: 11 }}
      >
        {action.label}
      </button>
    </div>
  );
}

function ServerGlyph({ server, size }: { server: MarketServer; size: number }) {
  const icon = resolveMarketplaceIcon(server);
  const candidates = iconCandidates(server);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: src ? "#10141E" : `linear-gradient(145deg, ${icon.hue}33, #10141E)`,
        border: `1px solid ${icon.hue}66`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size > 40 ? 16 : 12,
        fontWeight: 700,
        color: icon.hue,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() => setIndex((i) => i + 1)}
          style={{ width: size, height: size, objectFit: "cover" }}
        />
      ) : (
        icon.letters
      )}
    </div>
  );
}

function Section({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "var(--orvyn-text-muted)", fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", padding: "10px 12px 4px", cursor: "pointer" }}>
        <span>{open ? "▾" : "▸"}</span>
        <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
        <span>{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function FilterPopover({ filters, onChange, onClose }: { filters: MarketFilters; onChange: (f: MarketFilters) => void; onClose: () => void }) {
  const toggleSrc = (s: MarketSource) => {
    const sources = filters.sources.includes(s) ? filters.sources.filter((x) => x !== s) : [...filters.sources, s];
    onChange({ ...filters, sources });
  };
  return (
    <div style={{ ...menuBox, position: "absolute", right: 12, top: 78, width: 260, zIndex: 30 }}>
      <div style={filterHead}>Source</div>
      {(["official", "glama", "smithery", "private", "local"] as MarketSource[]).map((s) => (
        <label key={s} style={menuItem}><input type="checkbox" checked={filters.sources.includes(s)} onChange={() => toggleSrc(s)} /> {SOURCE_LABEL[s]}</label>
      ))}
      <div style={filterHead}>Status</div>
      {(["", "installed", "not-installed", "needs-auth", "update"] as const).map((s) => (
        <button key={s || "any"} style={menuItem} onClick={() => onChange({ ...filters, status: s })}>{s || "Any"}</button>
      ))}
      <div style={filterHead}>Trust</div>
      {(["", "verified", "community", "unverified"] as const).map((s) => (
        <button key={s || "anyt"} style={menuItem} onClick={() => onChange({ ...filters, trust: s })}>{s || "Any"}</button>
      ))}
      <div style={filterHead}>Execution</div>
      {(["", "local", "remote", "cloud"] as const).map((s) => (
        <button key={s || "anye"} style={menuItem} onClick={() => onChange({ ...filters, execution: s })}>{s || "Any"}</button>
      ))}
      <div style={filterHead}>Transport</div>
      {(["", "stdio", "http"] as const).map((s) => (
        <button key={s || "anytr"} style={menuItem} onClick={() => onChange({ ...filters, transport: s })}>{s === "http" ? "Streamable HTTP" : s || "Any"}</button>
      ))}
      <div style={filterHead}>Category</div>
      {CATEGORIES.map((c) => (
        <button key={c} style={menuItem} onClick={() => onChange({ ...filters, category: filters.category === c ? "" : c })}>{c}</button>
      ))}
      <button style={{ ...menuItem, color: "var(--orvyn-cyan)" }} onClick={() => { onChange(EMPTY_FILTERS); onClose(); }}>Clear filters</button>
    </div>
  );
}

function OverflowMenu({ onAddServer, onAddRegistry, onClose }: { onAddServer: () => void; onAddRegistry: () => void; onClose: () => void }) {
  return (
    <div style={{ ...menuBox, position: "absolute", right: 12, top: 78, zIndex: 30 }}>
      <button style={menuItem} onClick={() => { onAddServer(); onClose(); }}>Add MCP Server</button>
      <button style={menuItem} onClick={() => { onAddRegistry(); onClose(); }}>Add private registry</button>
    </div>
  );
}

function InstallDrawer({ server, busy, onClose, onInstall }: { server: MarketServer; busy: boolean; onClose: () => void; onInstall: (secrets?: Record<string, string>) => void }) {
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const steps = ["Review", "Permissions", "Authentication", "Confirm", "Done"];
  const p = permissionSummary(server);
  return (
    <div style={drawerScrim} onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()} style={drawer}>
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>{steps[step]}</div>
        <div style={{ fontSize: 18, fontWeight: 650, margin: "6px 0 12px" }}>{serverLabel(server)}</div>
        {step === 0 && <p style={body}>{server.description}</p>}
        {step === 1 && (
          <div>
            {p.can.map((x) => <div key={x} style={body}>✓ {x}</div>)}
            {p.may.map((x) => <div key={x} style={body}>⚠ {x}</div>)}
          </div>
        )}
        {step === 2 && (
          server.auth.some((a) => a.kind === "oauth") ? (
            <p style={body}>OAuth runs after install. Tokens stay in the secret store.</p>
          ) : (
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API token (secret ref only)" style={searchInput} />
          )
        )}
        {step === 3 && <p style={body}>Pin {server.version ?? "the advertised version"} and install into McpManager. Executable servers start only after this confirmation.</p>}
        {step === 4 && <p style={body}>Installed. ORION will not load the catalog — only search_capabilities plus activated tools.</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button style={ghostBtn} onClick={onClose}>Close</button>
          {step < 3 && <button style={primaryBtn} onClick={() => setStep(step + 1)}>Continue</button>}
          {step === 3 && <button disabled={busy} style={primaryBtn} onClick={() => { onInstall(token ? { token } : undefined); setStep(4); }}>{busy ? "Working…" : "Confirm"}</button>}
        </div>
      </aside>
    </div>
  );
}

function SettingsDrawer({ server, onClose, onScope, onConnect }: { server: MarketServer; onClose: () => void; onScope?: (s: "global" | "project" | "run") => void; onConnect: () => void }) {
  return (
    <div style={drawerScrim} onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()} style={drawer}>
        <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 12 }}>{serverLabel(server)} settings</div>
        <ConfigurationTab server={server} onScope={onScope} />
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {server.auth.some((a) => a.kind === "oauth") && <button style={primaryBtn} onClick={onConnect}>Connect account</button>}
          <button style={ghostBtn} onClick={onClose}>Close</button>
        </div>
      </aside>
    </div>
  );
}

function ConfirmDialog({ title, body, confirm, onCancel, onConfirm }: { title: string; body: string; confirm: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div style={drawerScrim} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...drawer, width: 400 }}>
        <div style={{ fontSize: 16, fontWeight: 650 }}>{title}</div>
        <p style={bodyText}>{body}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={ghostBtn} onClick={onCancel}>Cancel</button>
          <button style={{ ...primaryBtn, background: "var(--orvyn-red, #F25F75)" }} onClick={onConfirm}>{confirm}</button>
        </div>
      </div>
    </div>
  );
}

function ProviderDots({ providers }: { providers: Record<string, ProviderStatusView> }) {
  const dots = providerDots(providers);
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>
      {dots.map((d) => (
        <span key={d.id} title={d.title} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {d.label}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: d.filled ? "var(--orvyn-green, #20D89B)" : "transparent",
              border: d.filled ? "none" : "1px solid var(--orvyn-text-muted)",
            }}
          />
        </span>
      ))}
    </div>
  );
}

function EmptyDetail({ loading, query }: { loading: boolean; query: string }) {
  return (
    <div style={{ padding: 40, color: "var(--orvyn-text-muted)", fontSize: 13.5 }}>
      {loading ? "Searching registries…" : query ? `No server selected for “${query}”.` : "Select an MCP server from the marketplace."}
    </div>
  );
}

function SkeletonList() {
  return (
    <div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{ height: 56, margin: "6px 12px", borderRadius: 8, background: "rgba(255,255,255,0.04)" }} />
      ))}
    </div>
  );
}

function PrivateRegistries({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("Organization registry");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [glama, setGlama] = useState("");
  const [configured, setConfigured] = useState<{ glama?: boolean; smithery?: boolean }>({});
  useEffect(() => {
    void fetch(apiUrl("/mcp/marketplace/secrets"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((body) => setConfigured(body.configured ?? {}))
      .catch(() => undefined);
  }, []);
  async function save() {
    await fetch(apiUrl("/mcp/marketplace/registries"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name, url, token }),
    });
    setToken("");
    onSaved();
  }
  async function saveGlama() {
    const res = await fetch(apiUrl("/mcp/marketplace/secrets"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ glama }),
    });
    const body = await res.json().catch(() => ({}));
    setConfigured(body.configured ?? {});
    setGlama("");
    onSaved();
  }
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 6 }}>
        Glama directory key {configured.glama ? "· configured" : "· not set"}
      </div>
      <input style={{ ...searchInput, marginBottom: 6 }} type="password" value={glama} onChange={(e) => setGlama(e.target.value)} placeholder="glm_… stored as mcp.secret.glama" />
      <button onClick={() => void saveGlama()} style={{ ...ghostBtn, marginBottom: 14 }}>Save Glama key</button>
      <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 6 }}>Private registry (Official API)</div>
      <input style={{ ...searchInput, marginBottom: 6 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input style={{ ...searchInput, marginBottom: 6 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://registry.example.com" />
      <input style={{ ...searchInput, marginBottom: 6 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer token (optional)" />
      <button onClick={() => void save()} style={ghostBtn}>Save registry</button>
    </div>
  );
}

function IconBtn({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) {
  return (
    <button title={title} onClick={onClick} style={{ ...ghostBtn, padding: "0 8px", minWidth: 30, background: active ? "rgba(85,99,245,0.18)" : "transparent" }}>
      {children}
    </button>
  );
}

function Meta({ row, value }: { row: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13, padding: "7px 0", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
      <span style={{ width: 120, color: "var(--orvyn-text-muted)", flexShrink: 0 }}>{row}</span>
      <span style={{ overflowWrap: "break-word", wordBreak: "normal", minWidth: 0 }}>{value}</span>
    </div>
  );
}

const searchInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  width: "100%",
  background: "var(--orvyn-bg, #0B0E14)",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 7,
  color: "var(--orvyn-text)",
  fontSize: 12.5,
  padding: "7px 10px",
  outline: "none",
};
const badge: React.CSSProperties = {
  fontSize: 9.5,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 99,
  padding: "1px 6px",
};
const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 7,
  color: "var(--orvyn-text-secondary)",
  fontSize: 12,
  padding: "6px 12px",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  background: "var(--orvyn-purple, #6C5CFF)",
  border: "none",
  borderRadius: 7,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 14px",
  cursor: "pointer",
};
const h2: React.CSSProperties = { fontSize: 22, fontWeight: 650, letterSpacing: "-0.02em", margin: "0 0 10px" };
const h3: React.CSSProperties = { fontSize: 13, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--orvyn-text-muted)", margin: "18px 0 8px" };
const body: React.CSSProperties = { fontSize: 14.5, lineHeight: 1.55, color: "var(--orvyn-text-secondary)", margin: "0 0 8px" };
const bodyText = body;
const menuBox: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: 36,
  background: "var(--orvyn-surface-2, #121724)",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 8,
  minWidth: 180,
  padding: 6,
  zIndex: 40,
};
const menuItem: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  color: "var(--orvyn-text-secondary)",
  fontSize: 12,
  padding: "6px 8px",
  cursor: "pointer",
};
const filterHead: React.CSSProperties = { fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--orvyn-text-muted)", padding: "8px 8px 2px" };
const drawerScrim: React.CSSProperties = { position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 50, display: "flex", justifyContent: "flex-end" };
const drawer: React.CSSProperties = { width: "min(440px, 100%)", height: "100%", background: "var(--orvyn-surface-2, #121724)", borderLeft: "1px solid var(--orvyn-border)", padding: 22, overflowY: "auto" };
