"use client";
import { useMemo, useState } from "react";
import { fmtTime, type RevisionJ, type RunbookJ } from "../lib/api";
import { RevisionAudio } from "./RevisionAudio";

const k = (s: unknown) => JSON.stringify(s);
const stepText = (s: Record<string, unknown>) => {
  const { action, ...rest } = s;
  const args = Object.entries(rest)
    .map(([a, v]) => `${a}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join(" ");
  return `${action}${args ? " " + args : ""}`;
};

export function RunbookEvolution(props: { tenantId: string; voice: boolean; runbooks: RunbookJ[]; revisions: RevisionJ[]; selectedRunbookId: string | null; onSelectRunbook: (id: string) => void }) {
  const runbook = props.runbooks.find((r) => r._id === props.selectedRunbookId) ?? props.runbooks[0] ?? null;
  const revisions = useMemo(() => props.revisions.filter((r) => r.runbook_id === runbook?._id).sort((a, b) => a.to_version - b.to_version), [props.revisions, runbook]);
  const [selVersion, setSelVersion] = useState<number | null>(null);
  const shown = revisions.find((r) => r.to_version === selVersion) ?? revisions.at(-1) ?? null;

  const from = runbook?.versions.find((v) => v.version === shown?.from_version);
  const to = runbook?.versions.find((v) => v.version === shown?.to_version);
  const added = new Set((shown?.diff.added ?? []).map(k));
  const removed = new Set((shown?.diff.removed ?? []).map(k));

  return (
    <section className="panel" aria-labelledby="rb-h">
      <header className="panel-h">
        <h2 id="rb-h">Runbook evolution</h2>
        <select value={runbook?._id ?? ""} onChange={(e) => props.onSelectRunbook(e.target.value)} aria-label="runbook">
          {props.runbooks.map((r) => (
            <option key={r._id} value={r._id}>
              {r.incident_type.replace("_", " ")} · v{r.current_version} · {r.stats.verified_successes}/{r.stats.attempts}
            </option>
          ))}
        </select>
      </header>
      {runbook && (
        <>
          <ol className="timeline" aria-label="version timeline">
            {runbook.versions.map((v) => (
              <li key={v.version} className={`tl ${shown && v.version === shown.to_version ? "tl-sel" : ""}`}>
                <button className="tl-btn" onClick={() => setSelVersion(v.version)} disabled={v.version === 1}>
                  v{v.version}
                </button>
                <span className="muted small">{v.reason}</span>
              </li>
            ))}
          </ol>
          {shown ? (
            <>
              <div className="diff">
                <div>
                  <h3>
                    v{shown.from_version} <span className="muted">before</span>
                  </h3>
                  <ol className="stepsList">
                    {from?.steps.map((s, i) => (
                      <li key={i} className={removed.has(k(s)) ? "d-removed" : ""}>
                        {stepText(s as Record<string, unknown>)}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h3>
                    v{shown.to_version} <span className="muted">after</span>
                  </h3>
                  <ol className="stepsList">
                    {to?.steps.map((s, i) => (
                      <li key={i} className={added.has(k(s)) ? "d-added" : ""}>
                        {stepText(s as Record<string, unknown>)}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <dl className="kv">
                <dt>Trigger</dt>
                <dd>
                  rolling success <b>{shown.trigger.success_rate}</b> over last {shown.trigger.window} attempts · {shown.trigger.failed_attempt_ids.length} failed attempts · {fmtTime(shown.created_at)}
                </dd>
                <dt>Change</dt>
                <dd>{shown.diff.summary}</dd>
                <dt>Root cause (Claude)</dt>
                <dd>
                  {shown.rationale}
                  {props.voice && (
                    <div style={{ marginTop: 6 }}>
                      <RevisionAudio key={shown._id} tenantId={props.tenantId} revisionId={shown._id} />
                    </div>
                  )}
                </dd>
              </dl>
            </>
          ) : (
            <p className="muted">
              No revisions yet for this runbook — current steps:
              <br />
              <code>{runbook.versions.find((v) => v.version === runbook.current_version)?.steps.map((s) => stepText(s as Record<string, unknown>)).join(" → ")}</code>
            </p>
          )}
        </>
      )}
    </section>
  );
}
