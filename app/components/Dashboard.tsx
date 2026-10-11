"use client";
import { useEffect, useState } from "react";
import { api, type Health, type Roster } from "../lib/api";
import { useTenantLive } from "../lib/useTenantLive";
import { IncidentFeed } from "./IncidentFeed";
import { RunbookEvolution } from "./RunbookEvolution";
import { MetricsPanel } from "./MetricsPanel";
import { IsolationProof } from "./IsolationProof";

export function Dashboard() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [tenantId, setTenantId] = useState("harbor-law");
  const [runbookId, setRunbookId] = useState<string | null>(null);
  const live = useTenantLive(tenantId);

  useEffect(() => {
    api.roster().then(setRoster).catch(() => setRoster(null));
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // Default the runbook selector to this tenant's DNS runbook (the demo's star).
  useEffect(() => {
    const rbs = live.overview?.runbooks ?? [];
    if (rbs.length && (!runbookId || !rbs.some((r) => r._id === runbookId))) setRunbookId(rbs.find((r) => r.incident_type === "dns_misconfig")?._id ?? rbs[0]._id);
  }, [live.overview, runbookId]);

  const tenant = roster?.tenants.find((t) => t.id === tenantId);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>MSP Ops Agent</h1>
          <p className="muted">Self-improving runbooks on MongoDB Atlas — incidents → tenant-filtered hybrid recall → Claude adapts → simulator verifies → runbooks rewrite themselves.</p>
        </div>
        {health && (
          <ul className="chips" aria-label="cluster health">
            <li className="chip">Atlas {health.serverVersion}</li>
            <li className="chip">{health.encryption === "queryable-encryption" ? "Queryable Encryption" : health.encryption}</li>
            <li className="chip">hybrid: {health.hybridSearch.startsWith("$rankFusion") ? "$rankFusion" : "manual RRF"}</li>
            <li className="chip">
              {health.embeddings.provider}/{health.embeddings.model} · {health.embeddings.dims}d
            </li>
            <li className="chip">{health.claudeModel}</li>
            <li className={`chip ${health.searchIndexes.every((i) => i.queryable) ? "chip-ok" : "chip-warn"}`}>{health.searchIndexes.filter((i) => i.queryable).length}/2 search indexes ready</li>
          </ul>
        )}
      </header>

      <nav className="tabs" aria-label="tenants">
        {(roster?.tenants ?? []).map((t) => (
          <button key={t.id} className={`tab ${t.id === tenantId ? "tab-on" : ""}`} onClick={() => setTenantId(t.id)}>
            {t.name}
            {t.quirk && <span className="dot-warn" title="hidden GPO quirk" />}
          </button>
        ))}
      </nav>

      {live.error && <p className="err">{live.error}</p>}

      <div className="grid">
        <IncidentFeed
          tenantId={tenantId}
          tenantName={tenant?.name ?? tenantId}
          quirk={Boolean(tenant?.quirk)}
          incidentTypes={roster?.incidentTypes ?? []}
          runs={live.overview?.runs ?? []}
          connected={live.connected}
          onFired={() => void live.reload()}
        />
        <RunbookEvolution tenantId={tenantId} voice={Boolean(health?.voice)} runbooks={live.overview?.runbooks ?? []} revisions={live.overview?.revisions ?? []} selectedRunbookId={runbookId} onSelectRunbook={setRunbookId} />
        <MetricsPanel tenantId={tenantId} runbooks={live.overview?.runbooks ?? []} selectedRunbookId={runbookId} version={live.attemptsVersion} />
        <IsolationProof tenants={roster?.tenants ?? []} tenantA={tenantId} />
      </div>
      <footer className="foot muted small">
        {live.lastEvent ? `last change-stream event: ${live.lastEvent}` : "waiting for change-stream events"} · synthetic data only · tenant filter enforced in db/tenantScoped.ts
      </footer>
    </main>
  );
}
