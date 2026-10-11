"use client";
// One EventSource per tenant → change-stream events from /api/stream. The
// overview is fetched once; events patch it in place (agent_runs upserts,
// attempts prepend, revisions prepend) and bump a counter the metrics chart watches.
import { useEffect, useRef, useState, useCallback } from "react";
import { api, type AgentRunJ, type AttemptJ, type Overview, type RevisionJ } from "./api";

export type LiveState = { overview: Overview | null; error: string | null; connected: boolean; attemptsVersion: number; lastEvent: string | null };

export function useTenantLive(tenantId: string) {
  const [state, setState] = useState<LiveState>({ overview: null, error: null, connected: false, attemptsVersion: 0, lastEvent: null });
  const esRef = useRef<EventSource | null>(null);

  const reload = useCallback(async () => {
    try {
      const overview = await api.overview(tenantId);
      setState((s) => ({ ...s, overview, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message }));
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
    const es = new EventSource(`/api/stream?tenant=${tenantId}`);
    esRef.current = es;
    es.addEventListener("hello", () => setState((s) => ({ ...s, connected: true })));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));

    es.addEventListener("agent_runs", (ev) => {
      const { doc } = JSON.parse((ev as MessageEvent).data) as { doc: AgentRunJ };
      setState((s) => {
        if (!s.overview) return s;
        const runs = [doc, ...s.overview.runs.filter((r) => r._id !== doc._id)].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12);
        return { ...s, overview: { ...s.overview, runs }, lastEvent: `agent_runs ${doc.status}` };
      });
    });
    es.addEventListener("attempts", (ev) => {
      const { doc } = JSON.parse((ev as MessageEvent).data) as { doc: AttemptJ };
      setState((s) => {
        if (!s.overview) return s;
        const attempts = [doc, ...s.overview.attempts.filter((a) => a._id !== doc._id)].slice(0, 30);
        return { ...s, overview: { ...s.overview, attempts }, attemptsVersion: s.attemptsVersion + 1, lastEvent: `attempt ${doc.verification.passed ? "passed" : "failed"}` };
      });
    });
    es.addEventListener("revisions", (ev) => {
      const { doc } = JSON.parse((ev as MessageEvent).data) as { doc: RevisionJ };
      setState((s) => {
        if (!s.overview) return s;
        const revisions = [doc, ...s.overview.revisions.filter((r) => r._id !== doc._id)];
        return { ...s, overview: { ...s.overview, revisions }, attemptsVersion: s.attemptsVersion + 1, lastEvent: `revision v${doc.from_version}→v${doc.to_version}` };
      });
      void reload(); // runbooks changed (new version) — refetch
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [tenantId, reload]);

  return { ...state, reload };
}
