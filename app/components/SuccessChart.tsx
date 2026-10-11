"use client";
// Verified success rate over time for one runbook (single series → no legend),
// with each revision marked. Pure SVG, one y-axis, hover crosshair + tooltip,
// and a table view for accessibility.
import { useId, useMemo, useState } from "react";
import { fmtDay, fmtTime, type MetricJ } from "../lib/api";

type Props = { series: MetricJ[]; revisions: { at: string; to_version: number }[]; title: string };

const W = 640, H = 220, M = { l: 40, r: 16, t: 16, b: 34 };

export function SuccessChart({ series, revisions, title }: Props) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const pts = useMemo(() => {
    if (series.length === 0) return [];
    const ts = series.map((p) => +new Date(p.timestamp));
    const min = Math.min(...ts), max = Math.max(...ts);
    const span = Math.max(max - min, 1);
    return series.map((p, i) => ({ ...p, x: M.l + ((ts[i] - min) / span) * (W - M.l - M.r), y: M.t + (1 - p.rolling_success_rate) * (H - M.t - M.b), t: ts[i] }));
  }, [series]);

  const xOf = (iso: string) => {
    if (pts.length === 0) return null;
    const t = +new Date(iso);
    const min = pts[0].t, max = pts[pts.length - 1].t;
    if (t < min || t > max) return null;
    return M.l + ((t - min) / Math.max(max - min, 1)) * (W - M.l - M.r);
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (pts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[best].x - x)) best = i;
    setHover(best);
  };

  const path = pts.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `H${p.x}V${p.y}`)).join(" ");
  const h = hover !== null ? pts[hover] : null;

  return (
    <figure className="chart">
      <figcaption className="chart-cap">
        <span>{title}</span>
        <button className="btn btn-ghost small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {pts.length === 0 ? (
        <p className="muted">No attempts recorded for this runbook yet.</p>
      ) : table ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Version</th>
              <th>Verified</th>
              <th>Rolling rate</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p, i) => (
              <tr key={i}>
                <td>
                  {fmtDay(p.timestamp)} {fmtTime(p.timestamp)}
                </td>
                <td>v{p.runbook_version}</td>
                <td>{p.passed ? "✓ pass" : "✗ fail"}</td>
                <td>{p.rolling_success_rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="chart-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <title id={`${id}-t`}>{title}</title>
          {[0, 0.5, 1].map((v) => {
            const y = M.t + (1 - v) * (H - M.t - M.b);
            return (
              <g key={v}>
                <line x1={M.l} x2={W - M.r} y1={y} y2={y} className="grid" />
                <text x={M.l - 8} y={y + 4} textAnchor="end" className="axis-t">
                  {Math.round(v * 100)}%
                </text>
              </g>
            );
          })}
          {revisions.map((r) => {
            const x = xOf(r.at);
            return x === null ? null : (
              <g key={r.at}>
                <line x1={x} x2={x} y1={M.t} y2={H - M.b} className="rev-line" />
                <text x={x + 4} y={M.t + 10} className="rev-t">
                  v{r.to_version}
                </text>
              </g>
            );
          })}
          <path d={path} className="series" />
          {pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={i === hover ? 6 : 4} className={p.passed ? "pt pt-pass" : "pt pt-fail"} />
          ))}
          {h && (
            <g>
              <line x1={h.x} x2={h.x} y1={M.t} y2={H - M.b} className="crosshair" />
              <foreignObject x={Math.min(h.x + 8, W - 190)} y={M.t} width={180} height={70}>
                <div className="tip">
                  <div>
                    {fmtDay(h.timestamp)} {fmtTime(h.timestamp)} · v{h.runbook_version}
                  </div>
                  <div>
                    {h.passed ? "✓ verified" : "✗ failed"} · rolling <b>{Math.round(h.rolling_success_rate * 100)}%</b>
                  </div>
                </div>
              </foreignObject>
            </g>
          )}
          <text x={M.l} y={H - 8} className="axis-t">
            {fmtDay(series[0].timestamp)}
          </text>
          <text x={W - M.r} y={H - 8} textAnchor="end" className="axis-t">
            {fmtDay(series[series.length - 1].timestamp)}
          </text>
        </svg>
      )}
    </figure>
  );
}
