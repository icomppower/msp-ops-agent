"use client";
import { useState } from "react";
import { api, type Proof } from "../lib/api";

export function IsolationProof(props: { tenants: { id: string; name: string }[]; tenantA: string }) {
  const [b, setB] = useState(() => props.tenants.find((t) => t.id !== props.tenantA)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The roster loads after first render, so fall back to the first other tenant until a choice is made.
  const tenantB = b && b !== props.tenantA && props.tenants.some((t) => t.id === b) ? b : (props.tenants.find((t) => t.id !== props.tenantA)?.id ?? "");

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setProof(await api.proof(props.tenantA, tenantB));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="iso-h">
      <header className="panel-h">
        <h2 id="iso-h">Isolation proof</h2>
      </header>
      <p className="muted small">
        Plants a near-duplicate of <b>{props.tenantA}</b>&apos;s latest DNS incident (same vector, same title) inside another tenant, then searches as {props.tenantA}. The filter is injected by <code>db/tenantScoped.ts</code>, not by the prompt.
      </p>
      <div className="fire-row">
        <label>
          plant into{" "}
          <select value={tenantB} onChange={(e) => setB(e.target.value)} aria-label="tenant B">
            {props.tenants
              .filter((t) => t.id !== props.tenantA)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run cross-tenant query"}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {proof && (
        <>
          <div className="proof-grid">
            <div className="stat">
              <span className="stat-l">Cross-tenant results</span>
              <span className={`stat-v ${proof.cross_tenant_results === 0 ? "ok" : "bad"}`}>{proof.cross_tenant_results}</span>
            </div>
            <div className="stat">
              <span className="stat-l">Planted doc indexed for {proof.tenantB}</span>
              <span className="stat-v">{proof.planted.indexed_visible_to_B ? "yes" : "pending"}</span>
            </div>
            <div className="stat">
              <span className="stat-l">{proof.tenantA} hits (vector / hybrid)</span>
              <span className="stat-v">
                {proof.tenantA_vector_hits.length} / {proof.tenantA_hybrid_hits.length}
              </span>
            </div>
          </div>
          <details open>
            <summary>$vectorSearch pipeline as executed for {proof.tenantA}</summary>
            <pre className="code">{JSON.stringify(proof.pipeline, null, 2)}</pre>
          </details>
          <details>
            <summary>{proof.tenantA} results ({proof.tenantA_vector_hits.length}) — all tenant_id = {proof.tenantA}</summary>
            <ul className="small">
              {proof.tenantA_vector_hits.map((h) => (
                <li key={h.id}>
                  <code>{h.tenant_id}</code> {h.title}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
