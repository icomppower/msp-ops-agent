// Quick check of the active embedding provider: dims and a similarity sanity test.
import { embed } from "@/lib/embed";
import { embeddingProvider } from "@/lib/embedConfig";

const t0 = Date.now();
const [a, b, c] = await embed([
  "DNS resolution failing on workstations after GPO refresh",
  "Workstations cannot resolve internal hostnames; nslookup times out",
  "Print spooler service stuck, jobs queued",
]);
const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
console.log(
  JSON.stringify({
    provider: embeddingProvider,
    dims: a.length,
    sim_dns_vs_dns: +dot(a, b).toFixed(3),
    sim_dns_vs_print: +dot(a, c).toFixed(3),
    ms: Date.now() - t0,
  }),
);
