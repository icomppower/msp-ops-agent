"use client";
import { useState } from "react";
import { api, fmtTime, type AgentRunJ, type FireResult } from "../lib/api";

const STEP_LABEL: Record<string, string> = { embed: "Embed", recall: "Recall", select: "Select", execute: "Execute", verify: "Verify", record: "Record", revise: "Revise" };

function StepTracker({ run }: { run: AgentRunJ }) {
  return (
    <ol className="steps" aria-label="agent steps">
      {run.steps.map((s) => (
        <li key={s.name} className={`step step-${s.status}`} title={s.detail ?? ""}>
          <span className="step-dot" aria-hidden />
          <span className="step-name">{STEP_LABEL[s.name] ?? s.name}</span>
        </li>
      ))}
    </ol>
  );
}

export function IncidentFeed(props: {
  tenantId: string;
  tenantName: string;
  quirk: boolean;
  incidentTypes: string[];
  runs: AgentRunJ[];
  connected: boolean;
  onFired?: (r: FireResult) => void;
}) {
  const [type, setType] = useState("dns_misconfig");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<FireResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fire = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.fire(props.tenantId, type);
      setLast(r);
      props.onFired?.(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="feed-h">
      <header className="panel-h">
        <h2 id="feed-h">Incident feed</h2>
        <span className={`live ${props.connected ? "live-on" : ""}`}>{props.connected ? "● live (change stream)" : "○ reconnecting"}</span>
      </header>
      <div className="fire-row">
        <strong>{props.tenantName}</strong>
        {props.quirk && <span className="chip chip-muted">hidden quirk</span>}
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="incident type">
          {props.incidentTypes.map((t) => (
            <option key={t} value={t}>
              {t.replace("_", " ")}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={fire} disabled={busy}>
          {busy ? "Running agent…" : "Fire incident"}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {last && (
        <p className="result">
          Verification <b className={last.attempt.verification.passed ? "ok" : "bad"}>{last.attempt.verification.passed ? "PASSED" : "FAILED"}</b> · rolling {last.rolling.rate} over {last.rolling.n}
          {last.revision && (
            <>
              {" "}
              · <b>revision v{last.revision.revision.from_version}→v{last.revision.revision.to_version}</b>, replay {last.revision.replay.filter((r) => r.passed).length}/{last.revision.replay.length} passed, rate {last.revision.rate_before}→{last.revision.rate_after}
            </>
          )}
        </p>
      )}
      <ul className="runs">
        {props.runs.length === 0 && <li className="muted">No agent runs yet — fire an incident.</li>}
        {props.runs.map((run) => {
          const current = run.steps.find((s) => s.status === "running") ?? run.steps.filter((s) => s.status !== "pending").at(-1);
          return (
            <li key={run._id} className={`run run-${run.status}`}>
              <div className="run-top">
                <span className={`badge badge-${run.status}`}>{run.status}</span>
                <span className="muted">{fmtTime(run.created_at)}</span>
                {run.runbook_version && <span className="muted">runbook v{run.runbook_version}</span>}
              </div>
              <StepTracker run={run} />
              {current?.detail && <div className="run-detail">{current.detail}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
