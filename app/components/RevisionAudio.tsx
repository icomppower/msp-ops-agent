"use client";
import { useRef, useState } from "react";

type State = "idle" | "loading" | "playing" | "hidden";

export function RevisionAudio({ tenantId, revisionId }: { tenantId: string; revisionId: string }) {
  const [state, setState] = useState<State>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (state === "hidden") return null;

  async function onClick() {
    try {
      if (state === "playing") {
        audioRef.current?.pause();
        setState("idle");
        return;
      }
      setState("loading");
      const url = `/api/voice/${encodeURIComponent(revisionId)}?tenant=${encodeURIComponent(tenantId)}`;
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) return setState("hidden");
      const blobUrl = URL.createObjectURL(await res.blob());
      const audio = new Audio(blobUrl);
      audioRef.current = audio;
      audio.onended = () => setState("idle");
      audio.onerror = () => setState("hidden");
      await audio.play();
      setState("playing");
    } catch {
      setState("hidden");
    }
  }

  return (
    <button className="btn small" onClick={onClick} disabled={state === "loading"}>
      {state === "loading" ? <span className="muted">Loading…</span> : state === "playing" ? "Playing" : "▶ Listen"}
    </button>
  );
}
