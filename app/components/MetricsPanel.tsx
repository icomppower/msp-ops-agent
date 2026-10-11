"use client";
import { useEffect, useState } from "react";
import { api, type Metrics, type RunbookJ } from "../lib/api";
import { SuccessChart } from "./SuccessChart";

export function MetricsPanel(props: { tenantId: string; runbooks: RunbookJ[]; selectedRunbookId: string | null; version: number }) {
  const runbook = props.runbooks.find((r) => r._id === props.selectedRunbookId) ?? props.runbooks[0] ?? null;
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    if (!runbook) return;
    let live = true;
    api.metrics(props.tenantId, runbook._id).then((d) => live && setM(d)).catch(() => live && setM(null));
    return () => {
      live = false;
    };
  }, [props.tenantId, runbook?._id, props.version]);

  return (
    <section className="panel" aria-labelledby="met-h">
      <header className="panel-h">
        <h2 id="met-h">Metrics</h2>
        <span className="muted small">runbook_metrics · time series · meta {"{tenant_id, runbook_id}"}</span>
      </header>
      {runbook && (
        <div className="stat-row">
          <div className="stat">
            <span className="stat-l">Verified success</span>
            <span className="stat-v">
              {runbook.stats.verified_successes}/{runbook.stats.attempts}
            </span>
          </div>
          <div className="stat">
            <span className="stat-l">Rolling (last 3)</span>
            <span className="stat-v">{Math.round(runbook.stats.rolling_success_rate * 100)}%</span>
          </div>
          <div className="stat">
            <span className="stat-l">Version</span>
            <span className="stat-v">v{runbook.current_version}</span>
          </div>
        </div>
      )}
      <SuccessChart series={m?.series ?? []} revisions={m?.revisions ?? []} title={runbook ? `Rolling verified success — ${runbook.name}` : "Rolling verified success"} />
    </section>
  );
}
