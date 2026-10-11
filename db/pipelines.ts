// Aggregation pipelines as pure data. tenantScoped.ts is the only caller; every
// builder takes tenantId and bakes it into the first match/filter so no stage
// can run unscoped. No driver import here.
import { SEARCH_INDEXES } from "./jsonSchemas";

type Document = Record<string, unknown>;

export const RRF_K = 60;

// Rolling success over the last `window` attempts + the revision trigger,
// computed in Mongo. Returns [{ n, rate, trigger, failed_attempt_ids }].
export function rollingSuccessPipeline(tenantId: string, runbookId: unknown, window: number, threshold: number): Document[] {
  return [
    { $match: { tenant_id: tenantId, runbook_id: runbookId } },
    { $sort: { created_at: -1 } },
    { $limit: window },
    {
      $group: {
        _id: null,
        n: { $sum: 1 },
        rate: { $avg: { $cond: ["$verification.passed", 1, 0] } },
        failed_attempt_ids: { $push: { $cond: ["$verification.passed", "$$REMOVE", "$_id"] } },
      },
    },
    {
      $project: {
        _id: 0,
        n: 1,
        // 2-decimal rounding: 2/3 → 0.67 is NOT below 0.67, so one failure in the
        // window does not trigger; the second (0.33) does — matching the demo script.
        rate: { $round: ["$rate", 2] },
        failed_attempt_ids: 1,
        trigger: { $and: [{ $gte: ["$n", window] }, { $lt: [{ $round: ["$rate", 2] }, threshold] }] },
      },
    },
  ];
}

// Lifetime counters for runbooks.stats, recomputed from attempts.
export function recountStatsPipeline(tenantId: string, runbookId: unknown): Document[] {
  return [
    { $match: { tenant_id: tenantId, runbook_id: runbookId } },
    { $group: { _id: null, attempts: { $sum: 1 }, verified_successes: { $sum: { $cond: ["$verification.passed", 1, 0] } } } },
    { $project: { _id: 0, attempts: 1, verified_successes: 1 } },
  ];
}

// Tenant-filtered vector search. Exposed on its own because the isolation proof
// panel shows exactly this pipeline (filter included).
export function vectorSearchPipeline(tenantId: string, queryVector: number[], k: number): Document[] {
  return [
    {
      $vectorSearch: {
        index: SEARCH_INDEXES.vector.name,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(k * 10, 50),
        limit: k,
        filter: { tenant_id: tenantId },
      },
    },
    { $project: { embedding: 0, score: { $meta: "vectorSearchScore" } } },
  ];
}

// Hybrid search = vector ∪ full-text, fused with reciprocal rank fusion inside
// the aggregation ($rankFusion needs 8.1+; the cluster is 8.0). Both legs carry
// the tenant filter, and a final $match re-asserts it.
export function hybridSearchPipeline(tenantId: string, queryVector: number[], queryText: string, k: number): Document[] {
  const rankLeg = (): Document[] => [
    { $group: { _id: null, docs: { $push: "$$ROOT" } } },
    { $unwind: { path: "$docs", includeArrayIndex: "rank" } },
    { $project: { _id: "$docs._id", doc: "$docs", score: { $divide: [1, { $add: [RRF_K, "$rank"] }] } } },
  ];
  return [
    {
      $vectorSearch: {
        index: SEARCH_INDEXES.vector.name,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(k * 10, 50),
        limit: k,
        filter: { tenant_id: tenantId },
      },
    },
    ...rankLeg(),
    {
      $unionWith: {
        coll: "incidents",
        pipeline: [
          {
            $search: {
              index: SEARCH_INDEXES.text.name,
              compound: {
                must: [{ text: { query: queryText, path: ["title", "symptoms"] } }],
                filter: [{ equals: { path: "tenant_id", value: tenantId } }],
              },
            },
          },
          { $limit: k },
          ...rankLeg(),
        ],
      },
    },
    { $group: { _id: "$_id", doc: { $first: "$doc" }, rrf_score: { $sum: "$score" } } },
    { $match: { "doc.tenant_id": tenantId } },
    { $sort: { rrf_score: -1, _id: 1 } },
    { $limit: k },
    { $replaceWith: { $mergeObjects: ["$doc", { rrf_score: "$rrf_score" }] } },
    { $project: { embedding: 0 } },
  ];
}

// Success-rate series for the metrics panel, from the time series collection.
export function metricsSeriesPipeline(tenantId: string, runbookId: unknown, limit = 200): Document[] {
  return [
    { $match: { "meta.tenant_id": tenantId, "meta.runbook_id": runbookId } },
    { $sort: { timestamp: 1 } },
    { $limit: limit },
    { $project: { _id: 0, timestamp: 1, passed: 1, rolling_success_rate: 1, runbook_version: 1 } },
  ];
}
