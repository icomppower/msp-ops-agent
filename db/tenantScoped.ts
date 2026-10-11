// The ONLY module allowed to import the Mongo driver (enforced by eslint
// no-restricted-imports). Every tenant-facing export takes tenantId as its first
// argument and injects it into every filter, pipeline and $vectorSearch.
//
// Layout:
//   1. connection + encryption plumbing (private)
//   2. `admin` — schema setup / health / test hooks (never used by routes or agent code)
//   3. tenant-scoped data access (added in step 2)

import {
  MongoClient,
  ClientEncryption,
  Binary,
  ObjectId,
  type Db,
  type Document,
  type Collection,
  type ResumeToken,
} from "mongodb";
import { env } from "@/lib/env";
import {
  validators,
  TIME_SERIES,
  SEARCH_INDEXES,
  REGULAR_INDEXES,
  KEY_VAULT_COLLECTION,
  ENCRYPTED_FIELD_PATHS,
  dekAltName,
  type EncryptedFieldPath,
  type IncidentType,
} from "./jsonSchemas";
import {
  rollingSuccessPipeline,
  recountStatsPipeline,
  vectorSearchPipeline,
  hybridSearchPipeline,
  metricsSeriesPipeline,
} from "./pipelines";
import { REVISION_THRESHOLD, REVISION_WINDOW, type Step } from "@/lib/schemas";
import type {
  AgentRun,
  AgentRunStatus,
  AgentStepStatus,
  Attempt,
  AttemptPhase,
  Incident,
  MetricPoint,
  Revision,
  RollingStats,
  Runbook,
  StepResult,
  Tenant,
  Verification,
} from "@/lib/types";
import type { SimState } from "@/sim/engine";

// ---------------------------------------------------------------------------
// 1. Connection + encryption plumbing
// ---------------------------------------------------------------------------

let clientPromise: Promise<MongoClient> | null = null;

function keyVaultNamespace() {
  return `${env.mongoDb()}.${KEY_VAULT_COLLECTION}`;
}

function kmsProviders() {
  return { local: { key: env.qeMasterKey() } };
}

// One client for the whole process. autoEncryption with bypassQueryAnalysis gives
// automatic *decryption* on reads without needing crypt_shared/mongocryptd; writes
// to protected fields are encrypted explicitly via ClientEncryption below.
function getClient(): Promise<MongoClient> {
  clientPromise ??= (async () => {
    const client = new MongoClient(env.mongoUri(), {
      appName: "msp-ops-agent",
      autoEncryption: {
        keyVaultNamespace: keyVaultNamespace(),
        kmsProviders: kmsProviders(),
        bypassQueryAnalysis: true,
        extraOptions: { cryptSharedLibRequired: false },
      },
    });
    await client.connect();
    return client;
  })();
  return clientPromise;
}

async function getDb(): Promise<Db> {
  return (await getClient()).db(env.mongoDb());
}

// Database-level change streams are not supported through an auto-encryption
// client ("non-collection command not supported for auto encryption"), so
// watchTenant uses this plain client. The watched collections hold no encrypted fields.
let plainClientPromise: Promise<MongoClient> | null = null;
function getPlainClient(): Promise<MongoClient> {
  plainClientPromise ??= new MongoClient(env.mongoUri(), { appName: "msp-ops-agent-stream" }).connect();
  return plainClientPromise;
}

let encryptionPromise: Promise<ClientEncryption> | null = null;
function getClientEncryption(): Promise<ClientEncryption> {
  encryptionPromise ??= (async () => {
    const client = await getClient();
    return new ClientEncryption(client, { keyVaultNamespace: keyVaultNamespace(), kmsProviders: kmsProviders() });
  })();
  return encryptionPromise;
}

async function getDekId(path: EncryptedFieldPath): Promise<Binary> {
  const ce = await getClientEncryption();
  const key = await ce.getKeyByAltName(dekAltName(path));
  if (!key) throw new Error(`Data encryption key '${dekAltName(path)}' missing — run pnpm setup:atlas`);
  return key._id as Binary;
}

export type EncryptionMode = "queryable-encryption" | "csfle" | "none";

// Mode is derived from the live collection options, so no extra state is kept.
async function detectEncryptionMode(db: Db): Promise<EncryptionMode> {
  const [info] = await db.listCollections({ name: "incidents" }).toArray();
  if (!info) return "none";
  const opts = (info as { options?: { encryptedFields?: unknown } }).options;
  return opts?.encryptedFields ? "queryable-encryption" : "csfle";
}

let modeCache: EncryptionMode | null = null;
async function encryptionMode(): Promise<EncryptionMode> {
  modeCache ??= await detectEncryptionMode(await getDb());
  return modeCache;
}

// Encrypt one sensitive string with that field's own key. QE unindexed when the
// collection has encryptedFields, otherwise CSFLE random — both via libmongocrypt.
async function encryptField(path: EncryptedFieldPath, value: string): Promise<Binary> {
  const ce = await getClientEncryption();
  const keyId = await getDekId(path);
  const mode = await encryptionMode();
  return ce.encrypt(value, {
    keyId,
    algorithm: mode === "queryable-encryption" ? "Unindexed" : "AEAD_AES_256_CBC_HMAC_SHA_512-Random",
  });
}

// ---------------------------------------------------------------------------
// 2. admin — setup, health, test hooks. Not for routes or agent code.
// ---------------------------------------------------------------------------

function assertNotProduction(what: string) {
  if (env.isProduction && !process.env.ALLOW_ADMIN) {
    throw new Error(`admin.${what} is disabled in production (set ALLOW_ADMIN=1 to override)`);
  }
}

export type SetupReport = {
  collections: Record<string, "created" | "exists">;
  validators: Record<string, "set" | "unsupported">;
  encryption: EncryptionMode;
  deks: Record<string, "created" | "exists">;
  regularIndexes: number;
  searchIndexes: Record<string, "created" | "exists" | "updated">;
  notes: string[];
};

async function ensureKeyVaultAndDeks(db: Db, report: SetupReport): Promise<Record<EncryptedFieldPath, Binary>> {
  const kv = db.collection(KEY_VAULT_COLLECTION);
  await kv.createIndex({ keyAltNames: 1 }, { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } });
  const ce = await getClientEncryption();
  const out = {} as Record<EncryptedFieldPath, Binary>;
  for (const path of ENCRYPTED_FIELD_PATHS) {
    const alt = dekAltName(path);
    const existing = await ce.getKeyByAltName(alt);
    if (existing) {
      report.deks[alt] = "exists";
      out[path] = existing._id as Binary;
    } else {
      out[path] = await ce.createDataKey("local", { keyAltNames: [alt] });
      report.deks[alt] = "created";
    }
  }
  return out;
}

async function setValidator(db: Db, name: string, report: SetupReport) {
  try {
    await db.command({ collMod: name, validator: validators[name], validationLevel: "strict", validationAction: "error" });
    report.validators[name] = "set";
  } catch (e) {
    report.validators[name] = "unsupported";
    report.notes.push(`validator on ${name}: ${(e as Error).message}`);
  }
}

async function ensureIncidentsCollection(db: Db, deks: Record<EncryptedFieldPath, Binary>, existing: Set<string>, report: SetupReport) {
  const name = "incidents";
  if (existing.has(name)) {
    report.collections[name] = "exists";
    await setValidator(db, name, report);
    return;
  }
  const encryptedFields = {
    fields: ENCRYPTED_FIELD_PATHS.map((path) => ({ path, bsonType: "string", keyId: deks[path] })),
  };
  try {
    await db.createCollection(name, { encryptedFields, validator: validators[name] });
    report.collections[name] = "created";
    report.validators[name] = "set";
  } catch (e1) {
    report.notes.push(`incidents with encryptedFields+validator failed: ${(e1 as Error).message}`);
    try {
      await db.createCollection(name, { encryptedFields });
      report.collections[name] = "created";
      await setValidator(db, name, report);
    } catch (e2) {
      // Queryable Encryption not available on this tier → plain collection, CSFLE explicit encryption.
      report.notes.push(`Queryable Encryption unavailable, falling back to CSFLE: ${(e2 as Error).message}`);
      await db.createCollection(name, { validator: validators[name] });
      report.collections[name] = "created";
      report.validators[name] = "set";
    }
  }
}

async function ensureTimeSeries(db: Db, existing: Set<string>, report: SetupReport) {
  const name = "runbook_metrics";
  const timeseries = TIME_SERIES.runbook_metrics;
  if (existing.has(name)) {
    report.collections[name] = "exists";
    await setValidator(db, name, report);
    return;
  }
  try {
    await db.createCollection(name, { timeseries, validator: validators[name] });
    report.collections[name] = "created";
    report.validators[name] = "set";
  } catch (e) {
    report.notes.push(`time series with validator failed, creating without: ${(e as Error).message}`);
    await db.createCollection(name, { timeseries });
    report.collections[name] = "created";
    report.validators[name] = "unsupported";
  }
}

async function ensureSearchIndexes(incidents: Collection, report: SetupReport) {
  const current = (await incidents.listSearchIndexes().toArray()) as Array<{ name: string; latestDefinition?: Document }>;
  const byName = new Map(current.map((i) => [i.name, i]));
  for (const idx of Object.values(SEARCH_INDEXES)) {
    const found = byName.get(idx.name);
    if (!found) {
      await incidents.createSearchIndexes([{ name: idx.name, type: idx.type, definition: idx.definition }]);
      report.searchIndexes[idx.name] = "created";
    } else if (JSON.stringify(found.latestDefinition) !== JSON.stringify(idx.definition)) {
      await incidents.updateSearchIndex(idx.name, idx.definition);
      report.searchIndexes[idx.name] = "updated";
    } else {
      report.searchIndexes[idx.name] = "exists";
    }
  }
}

export type SearchIndexStatus = { name: string; type: string; status: string; queryable: boolean };

export type Health = {
  serverVersion: string;
  rankFusionSupported: boolean;
  encryption: EncryptionMode;
  deksPresent: number;
  collections: Record<string, { validator: boolean; timeseries: boolean; encryptedFields: boolean }>;
  searchIndexes: SearchIndexStatus[];
};

function versionAtLeast(version: string, major: number, minor: number) {
  const [a, b] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

export const admin = {
  /** Idempotent: creates/updates collections, validators, indexes, key vault + DEK. */
  async ensureSchema(): Promise<SetupReport> {
    assertNotProduction("ensureSchema");
    const db = await getDb();
    const report: SetupReport = { collections: {}, validators: {}, encryption: "none", deks: {}, regularIndexes: 0, searchIndexes: {}, notes: [] };

    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const deks = await ensureKeyVaultAndDeks(db, report);

    await ensureIncidentsCollection(db, deks, existing, report);
    for (const name of ["tenants", "runbooks", "attempts", "revisions", "agent_runs", "sim_state"]) {
      if (existing.has(name)) {
        report.collections[name] = "exists";
        await setValidator(db, name, report);
      } else {
        await db.createCollection(name, { validator: validators[name] });
        report.collections[name] = "created";
        report.validators[name] = "set";
      }
    }
    await ensureTimeSeries(db, existing, report);

    for (const [name, specs] of Object.entries(REGULAR_INDEXES)) {
      for (const spec of specs) {
        await db.collection(name).createIndex(spec.keys, spec.options);
        report.regularIndexes++;
      }
    }
    await ensureSearchIndexes(db.collection("incidents"), report);

    modeCache = null;
    report.encryption = await encryptionMode();
    return report;
  },

  async health(): Promise<Health> {
    const db = await getDb();
    const build = await db.command({ buildInfo: 1 });
    const serverVersion: string = build.version;
    const infos = (await db.listCollections().toArray()) as Array<{ name: string; type?: string; options?: Document }>;
    const collections: Health["collections"] = {};
    for (const c of infos) {
      if (c.name.startsWith("system.") || c.name.startsWith("enxcol_")) continue;
      collections[c.name] = {
        validator: Boolean(c.options?.validator),
        timeseries: c.type === "timeseries",
        encryptedFields: Boolean(c.options?.encryptedFields),
      };
    }
    const searchIndexes = collections.incidents
      ? ((await db.collection("incidents").listSearchIndexes().toArray()) as Array<Document>).map((i) => ({
          name: i.name as string,
          type: (i.type as string) ?? "search",
          status: i.status as string,
          queryable: Boolean(i.queryable),
        }))
      : [];
    const ce = await getClientEncryption();
    return {
      serverVersion,
      rankFusionSupported: versionAtLeast(serverVersion, 8, 1),
      encryption: await encryptionMode(),
      deksPresent: (await Promise.all(ENCRYPTED_FIELD_PATHS.map((p) => ce.getKeyByAltName(dekAltName(p))))).filter(Boolean).length,
      collections,
      searchIndexes,
    };
  },

  /** Poll until both Atlas Search indexes are queryable (M0 builds can take minutes). */
  async waitForSearchIndexes(timeoutMs = 240_000): Promise<SearchIndexStatus[]> {
    const start = Date.now();
    for (;;) {
      const { searchIndexes } = await admin.health();
      const want = Object.values(SEARCH_INDEXES).map((i) => i.name);
      const ready = want.every((n) => searchIndexes.find((s) => s.name === n)?.queryable);
      if (ready) return searchIndexes;
      if (searchIndexes.some((s) => s.status === "FAILED")) throw new Error(`search index failed: ${JSON.stringify(searchIndexes)}`);
      if (Date.now() - start > timeoutMs) throw new Error(`search indexes not queryable after ${timeoutMs}ms: ${JSON.stringify(searchIndexes)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  },

  /** Raw access for tests/scripts only. Refuses in production. */
  async withRaw<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    assertNotProduction("withRaw");
    return fn(await getDb());
  },

  async encryptForTest(path: EncryptedFieldPath, value: string): Promise<Binary> {
    assertNotProduction("encryptForTest");
    return encryptField(path, value);
  },

  async close() {
    if (clientPromise) await (await clientPromise).close();
    if (plainClientPromise) await (await plainClientPromise).close();
    plainClientPromise = null;
    clientPromise = null;
    encryptionPromise = null;
    modeCache = null;
  },
};

// ---------------------------------------------------------------------------
// 3. Tenant-scoped data access. tenantId is always the first argument and is
//    injected into every filter/pipeline. Driver types never leave this file.
// ---------------------------------------------------------------------------

const GLOBAL = "global";

function assertTenant(tenantId: string) {
  if (!tenantId || typeof tenantId !== "string") throw new Error("tenantId is required");
}

function assertDataTenant(tenantId: string) {
  assertTenant(tenantId);
  if (tenantId === GLOBAL) throw new Error("'global' is not a data tenant");
}

const oid = (id: string | ObjectId) => (id instanceof ObjectId ? id : new ObjectId(id));
const sid = (id: unknown) => String(id);

async function coll<T extends Document = Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}

// tenants and sim_state use the tenant slug as _id.
type SlugIdDoc = Document & { _id: string };

// --- tenants ----------------------------------------------------------------

export async function upsertTenant(tenantId: string, tenant: Omit<Tenant, "created_at">): Promise<void> {
  assertDataTenant(tenantId);
  if (tenant._id !== tenantId || tenant.tenant_id !== tenantId) throw new Error("tenant ids disagree");
  const c = await coll<SlugIdDoc>("tenants");
  await c.updateOne(
    { _id: tenantId, tenant_id: tenantId },
    { $set: { name: tenant.name, environment: tenant.environment }, $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  );
}

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  assertDataTenant(tenantId);
  const c = await coll<SlugIdDoc>("tenants");
  return (await c.findOne({ _id: tenantId, tenant_id: tenantId })) as Tenant | null;
}

// --- incidents --------------------------------------------------------------

export type NewIncident = {
  type: IncidentType;
  title: string;
  symptoms: string[];
  env_snapshot: { hostname: string; os: string; site: string; credentials: string; ips: string };
  embedding: number[];
  status?: Incident["status"];
  created_at?: Date;
};

// Strips the encrypted fields: nothing downstream (Claude, UI, SSE) ever sees them.
function publicIncident(doc: Document): Incident {
  const snap = (doc.env_snapshot ?? {}) as Record<string, unknown>;
  return {
    _id: sid(doc._id),
    tenant_id: doc.tenant_id as string,
    type: doc.type as IncidentType,
    title: doc.title as string,
    symptoms: doc.symptoms as string[],
    env_snapshot: { hostname: String(snap.hostname ?? ""), os: String(snap.os ?? ""), site: String(snap.site ?? "") },
    status: doc.status as Incident["status"],
    created_at: doc.created_at as Date,
    ...(doc.rrf_score !== undefined ? { rrf_score: doc.rrf_score as number } : {}),
  };
}

export async function insertIncident(tenantId: string, inc: NewIncident): Promise<string> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const { credentials, ips, ...plain } = inc.env_snapshot;
  const doc = {
    tenant_id: tenantId,
    type: inc.type,
    title: inc.title,
    symptoms: inc.symptoms,
    env_snapshot: { ...plain, credentials: await encryptField("env_snapshot.credentials", credentials), ips: await encryptField("env_snapshot.ips", ips) },
    embedding: inc.embedding,
    status: inc.status ?? "open",
    created_at: inc.created_at ?? new Date(),
  };
  const r = await c.insertOne(doc);
  return sid(r.insertedId);
}

export async function getIncident(tenantId: string, incidentId: string): Promise<Incident | null> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const doc = await c.findOne({ _id: oid(incidentId), tenant_id: tenantId }, { projection: { embedding: 0 } });
  return doc ? publicIncident(doc) : null;
}

export async function getIncidentEmbedding(tenantId: string, incidentId: string): Promise<number[] | null> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const doc = await c.findOne({ _id: oid(incidentId), tenant_id: tenantId }, { projection: { embedding: 1 } });
  return (doc?.embedding as number[] | undefined) ?? null;
}

export async function listIncidents(tenantId: string, opts: { limit?: number; type?: IncidentType } = {}): Promise<Incident[]> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const docs = await c
    .find({ tenant_id: tenantId, ...(opts.type ? { type: opts.type } : {}) }, { projection: { embedding: 0 } })
    .sort({ created_at: -1 })
    .limit(opts.limit ?? 50)
    .toArray();
  return docs.map(publicIncident);
}

export async function setIncidentStatus(tenantId: string, incidentId: string, status: Incident["status"]): Promise<void> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  await c.updateOne({ _id: oid(incidentId), tenant_id: tenantId }, { $set: { status } });
}

/** Remove this tenant's isolation-probe incidents (planted by the proof panel). */
export async function deleteProbeIncidents(tenantId: string): Promise<number> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  return (await c.deleteMany({ tenant_id: tenantId, "env_snapshot.site": "ISOLATION-PROBE" })).deletedCount;
}

export async function countIncidents(tenantId: string): Promise<number> {
  assertDataTenant(tenantId);
  return (await coll("incidents")).countDocuments({ tenant_id: tenantId });
}

/** Hybrid (vector + full-text, RRF-fused in Mongo) search, tenant-filtered on both legs. */
export async function searchSimilarIncidents(
  tenantId: string,
  queryVector: number[],
  queryText: string,
  k = 5,
  opts: { excludeIncidentId?: string } = {},
): Promise<Incident[]> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const docs = await c.aggregate(hybridSearchPipeline(tenantId, queryVector, queryText, k + 1)).toArray();
  return docs
    .map(publicIncident)
    .filter((d) => d._id !== opts.excludeIncidentId)
    .slice(0, k);
}

/** Vector-only search plus the exact pipeline that ran — for the isolation proof panel. */
export async function vectorSearchWithPipeline(
  tenantId: string,
  queryVector: number[],
  k = 5,
): Promise<{ results: Incident[]; pipeline: Document[] }> {
  assertDataTenant(tenantId);
  const c = await coll("incidents");
  const pipeline = vectorSearchPipeline(tenantId, queryVector, k);
  const docs = await c.aggregate(pipeline).toArray();
  const shown = vectorSearchPipeline(tenantId, [], k);
  (shown[0] as { $vectorSearch: Document }).$vectorSearch.queryVector = `<${queryVector.length}-dim vector>`;
  return { results: docs.map(publicIncident), pipeline: shown };
}

// --- runbooks ---------------------------------------------------------------

function publicRunbook(doc: Document): Runbook {
  return {
    _id: sid(doc._id),
    tenant_id: doc.tenant_id as string,
    name: doc.name as string,
    incident_type: doc.incident_type as IncidentType,
    current_version: doc.current_version as number,
    ...(doc.forked_from ? { forked_from: sid(doc.forked_from) } : {}),
    versions: doc.versions as Runbook["versions"],
    stats: doc.stats as Runbook["stats"],
    created_at: doc.created_at as Date,
  };
}

/** Upsert a read-only template. Only valid for tenantId === "global". */
export async function upsertGlobalRunbook(tenantId: string, tpl: { name: string; incident_type: IncidentType; steps: Step[] }): Promise<string> {
  assertTenant(tenantId);
  if (tenantId !== GLOBAL) throw new Error("templates belong to tenant 'global'");
  const c = await coll("runbooks");
  const existing = await c.findOne({ tenant_id: GLOBAL, incident_type: tpl.incident_type });
  if (existing) return sid(existing._id);
  const r = await c.insertOne({
    tenant_id: GLOBAL,
    name: tpl.name,
    incident_type: tpl.incident_type,
    current_version: 1,
    versions: [{ version: 1, steps: tpl.steps, created_at: new Date(), reason: "global template" }],
    stats: { attempts: 0, verified_successes: 0, rolling_success_rate: 1.0 },
    created_at: new Date(),
  });
  return sid(r.insertedId);
}

/** Tenant-owned runbooks first, then global templates. */
export async function listCandidateRunbooks(tenantId: string, incidentType?: IncidentType): Promise<Runbook[]> {
  assertDataTenant(tenantId);
  const c = await coll("runbooks");
  const docs = await c
    .find({ tenant_id: { $in: [tenantId, GLOBAL] }, ...(incidentType ? { incident_type: incidentType } : {}) })
    .sort({ incident_type: 1, created_at: 1 })
    .toArray();
  return docs.map(publicRunbook).sort((a, b) => Number(b.tenant_id === tenantId) - Number(a.tenant_id === tenantId));
}

export async function getRunbook(tenantId: string, runbookId: string): Promise<Runbook | null> {
  assertDataTenant(tenantId);
  const c = await coll("runbooks");
  const doc = await c.findOne({ _id: oid(runbookId), tenant_id: { $in: [tenantId, GLOBAL] } });
  return doc ? publicRunbook(doc) : null;
}

/** Global templates are read-only: adapting one forks a tenant-owned copy (idempotent per source). */
export async function forkRunbook(tenantId: string, globalRunbookId: string, steps: Step[], reason: string, createdAt: Date = new Date()): Promise<Runbook> {
  assertDataTenant(tenantId);
  const c = await coll("runbooks");
  const src = await c.findOne({ _id: oid(globalRunbookId), tenant_id: GLOBAL });
  if (!src) throw new Error(`global runbook ${globalRunbookId} not found`);
  const existing = await c.findOne({ tenant_id: tenantId, forked_from: src._id });
  if (existing) return publicRunbook(existing);
  const r = await c.insertOne({
    tenant_id: tenantId,
    name: `${src.name} (${tenantId})`,
    incident_type: src.incident_type,
    current_version: 1,
    forked_from: src._id,
    versions: [{ version: 1, steps, created_at: createdAt, reason }],
    stats: { attempts: 0, verified_successes: 0, rolling_success_rate: 1.0 },
    created_at: createdAt,
  });
  return publicRunbook((await c.findOne({ _id: r.insertedId, tenant_id: tenantId }))!);
}

export async function rollingStats(tenantId: string, runbookId: string): Promise<RollingStats> {
  assertDataTenant(tenantId);
  const c = await coll("attempts");
  const [row] = await c.aggregate(rollingSuccessPipeline(tenantId, oid(runbookId), REVISION_WINDOW, REVISION_THRESHOLD)).toArray();
  if (!row) return { n: 0, rate: 1, trigger: false, failed_attempt_ids: [] };
  return { n: row.n, rate: row.rate, trigger: row.trigger, failed_attempt_ids: (row.failed_attempt_ids as ObjectId[]).map(sid) };
}

/** Recompute lifetime + rolling stats in Mongo, store them, and append a runbook_metrics point. */
export async function updateRunbookStatsAfterAttempt(
  tenantId: string,
  runbookId: string,
  attempt: { passed: boolean; runbook_version: number; created_at: Date },
): Promise<RollingStats> {
  assertDataTenant(tenantId);
  const attempts = await coll("attempts");
  const [count] = await attempts.aggregate(recountStatsPipeline(tenantId, oid(runbookId))).toArray();
  const rolling = await rollingStats(tenantId, runbookId);
  const runbooks = await coll("runbooks");
  await runbooks.updateOne(
    { _id: oid(runbookId), tenant_id: tenantId },
    { $set: { stats: { attempts: count?.attempts ?? 0, verified_successes: count?.verified_successes ?? 0, rolling_success_rate: rolling.rate } } },
  );
  const metrics = await coll("runbook_metrics");
  await metrics.insertOne({
    timestamp: attempt.created_at,
    meta: { tenant_id: tenantId, runbook_id: oid(runbookId) },
    passed: attempt.passed,
    rolling_success_rate: rolling.rate,
    runbook_version: attempt.runbook_version,
  });
  return rolling;
}

export async function metricsSeries(tenantId: string, runbookId: string): Promise<MetricPoint[]> {
  assertDataTenant(tenantId);
  const c = await coll("runbook_metrics");
  return (await c.aggregate(metricsSeriesPipeline(tenantId, oid(runbookId))).toArray()) as MetricPoint[];
}

// --- attempts ---------------------------------------------------------------

function publicAttempt(doc: Document): Attempt {
  return {
    _id: sid(doc._id),
    tenant_id: doc.tenant_id as string,
    incident_id: sid(doc.incident_id),
    runbook_id: sid(doc.runbook_id),
    runbook_version: doc.runbook_version as number,
    steps_executed: doc.steps_executed as StepResult[],
    verification: doc.verification as Verification,
    phase: doc.phase as AttemptPhase,
    created_at: doc.created_at as Date,
  };
}

export async function insertAttempt(
  tenantId: string,
  a: { incident_id: string; runbook_id: string; runbook_version: number; steps_executed: StepResult[]; verification: Verification; phase: AttemptPhase; created_at?: Date },
): Promise<string> {
  assertDataTenant(tenantId);
  const c = await coll("attempts");
  const r = await c.insertOne({
    tenant_id: tenantId,
    incident_id: oid(a.incident_id),
    runbook_id: oid(a.runbook_id),
    runbook_version: a.runbook_version,
    steps_executed: a.steps_executed,
    verification: a.verification,
    phase: a.phase,
    created_at: a.created_at ?? new Date(),
  });
  return sid(r.insertedId);
}

export async function listAttempts(
  tenantId: string,
  opts: { runbookId?: string; incidentId?: string; incidentIds?: string[]; attemptIds?: string[]; limit?: number } = {},
): Promise<Attempt[]> {
  assertDataTenant(tenantId);
  const c = await coll("attempts");
  const filter: Document = { tenant_id: tenantId };
  if (opts.runbookId) filter.runbook_id = oid(opts.runbookId);
  if (opts.incidentId) filter.incident_id = oid(opts.incidentId);
  if (opts.incidentIds) filter.incident_id = { $in: opts.incidentIds.map(oid) };
  if (opts.attemptIds) filter._id = { $in: opts.attemptIds.map(oid) };
  const docs = await c.find(filter).sort({ created_at: -1 }).limit(opts.limit ?? 50).toArray();
  return docs.map(publicAttempt);
}

// --- revisions (transactional) ------------------------------------------------

function publicRevision(doc: Document): Revision {
  const trigger = doc.trigger as { failed_attempt_ids: ObjectId[]; success_rate: number; window: number };
  return {
    _id: sid(doc._id),
    tenant_id: doc.tenant_id as string,
    runbook_id: sid(doc.runbook_id),
    from_version: doc.from_version as number,
    to_version: doc.to_version as number,
    trigger: { ...trigger, failed_attempt_ids: trigger.failed_attempt_ids.map(sid) },
    diff: doc.diff as Revision["diff"],
    rationale: doc.rationale as string,
    created_at: doc.created_at as Date,
  };
}

/** New runbook version + its revision record, in one multi-document transaction. */
export async function commitRevision(
  tenantId: string,
  runbookId: string,
  rev: { steps: Step[]; rationale: string; diff: Revision["diff"]; trigger: Revision["trigger"]; reason: string },
): Promise<Revision> {
  assertDataTenant(tenantId);
  const client = await getClient();
  const db = client.db(env.mongoDb());
  const session = client.startSession();
  try {
    let revisionId: ObjectId | null = null;
    await session.withTransaction(async () => {
      const runbooks = db.collection("runbooks");
      const rb = await runbooks.findOne({ _id: oid(runbookId), tenant_id: tenantId }, { session });
      if (!rb) throw new Error(`runbook ${runbookId} not found for tenant ${tenantId} (global templates are read-only)`);
      const from = rb.current_version as number;
      const to = from + 1;
      const now = new Date();
      await runbooks.updateOne(
        { _id: rb._id, tenant_id: tenantId, current_version: from },
        { $set: { current_version: to }, $push: { versions: { version: to, steps: rev.steps, created_at: now, reason: rev.reason } } } as Document,
        { session },
      );
      const r = await db.collection("revisions").insertOne(
        {
          tenant_id: tenantId,
          runbook_id: rb._id,
          from_version: from,
          to_version: to,
          trigger: { ...rev.trigger, failed_attempt_ids: rev.trigger.failed_attempt_ids.map(oid) },
          diff: rev.diff,
          rationale: rev.rationale,
          created_at: now,
        },
        { session },
      );
      revisionId = r.insertedId;
    });
    const doc = await db.collection("revisions").findOne({ _id: revisionId!, tenant_id: tenantId });
    return publicRevision(doc!);
  } finally {
    await session.endSession();
  }
}

export async function listRevisions(tenantId: string, opts: { runbookId?: string; limit?: number } = {}): Promise<Revision[]> {
  assertDataTenant(tenantId);
  const c = await coll("revisions");
  const filter: Document = { tenant_id: tenantId };
  if (opts.runbookId) filter.runbook_id = oid(opts.runbookId);
  const docs = await c.find(filter).sort({ created_at: -1 }).limit(opts.limit ?? 20).toArray();
  return docs.map(publicRevision);
}

// --- agent_runs (the agent's working memory per incident) ------------------------

function publicAgentRun(doc: Document): AgentRun {
  return {
    _id: sid(doc._id),
    tenant_id: doc.tenant_id as string,
    incident_id: sid(doc.incident_id),
    status: doc.status as AgentRunStatus,
    steps: doc.steps as AgentRun["steps"],
    ...(doc.chosen_runbook_id ? { chosen_runbook_id: sid(doc.chosen_runbook_id) } : {}),
    ...(doc.runbook_version !== undefined ? { runbook_version: doc.runbook_version as number } : {}),
    created_at: doc.created_at as Date,
    updated_at: doc.updated_at as Date,
  };
}

export async function createAgentRun(tenantId: string, incidentId: string, stepNames: string[]): Promise<string> {
  assertDataTenant(tenantId);
  const c = await coll("agent_runs");
  const now = new Date();
  const r = await c.insertOne({
    tenant_id: tenantId,
    incident_id: oid(incidentId),
    status: "running",
    steps: stepNames.map((name) => ({ name, status: "pending", at: now })),
    created_at: now,
    updated_at: now,
  });
  return sid(r.insertedId);
}

export async function updateAgentRunStep(tenantId: string, runId: string, name: string, status: AgentStepStatus, detail?: string): Promise<void> {
  assertDataTenant(tenantId);
  const c = await coll("agent_runs");
  await c.updateOne(
    { _id: oid(runId), tenant_id: tenantId, "steps.name": name },
    { $set: { "steps.$.status": status, "steps.$.at": new Date(), ...(detail !== undefined ? { "steps.$.detail": detail } : {}), updated_at: new Date() } },
  );
}

export async function finishAgentRun(
  tenantId: string,
  runId: string,
  status: AgentRunStatus,
  extra: { chosen_runbook_id?: string; runbook_version?: number } = {},
): Promise<void> {
  assertDataTenant(tenantId);
  const c = await coll("agent_runs");
  await c.updateOne(
    { _id: oid(runId), tenant_id: tenantId },
    {
      $set: {
        status,
        updated_at: new Date(),
        ...(extra.chosen_runbook_id ? { chosen_runbook_id: oid(extra.chosen_runbook_id) } : {}),
        ...(extra.runbook_version !== undefined ? { runbook_version: extra.runbook_version } : {}),
      },
    },
  );
}

export async function getAgentRun(tenantId: string, runId: string): Promise<AgentRun | null> {
  assertDataTenant(tenantId);
  const c = await coll("agent_runs");
  const doc = await c.findOne({ _id: oid(runId), tenant_id: tenantId });
  return doc ? publicAgentRun(doc) : null;
}

export async function listAgentRuns(tenantId: string, limit = 20): Promise<AgentRun[]> {
  assertDataTenant(tenantId);
  const c = await coll("agent_runs");
  const docs = await c.find({ tenant_id: tenantId }).sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map(publicAgentRun);
}

// --- sim_state ----------------------------------------------------------------

export async function getSimState(tenantId: string): Promise<SimState | null> {
  assertDataTenant(tenantId);
  const c = await coll<SlugIdDoc>("sim_state");
  const doc = await c.findOne({ _id: tenantId, tenant_id: tenantId });
  return (doc?.state as SimState | undefined) ?? null;
}

export async function saveSimState(tenantId: string, state: SimState): Promise<void> {
  assertDataTenant(tenantId);
  const c = await coll<SlugIdDoc>("sim_state");
  await c.updateOne({ _id: tenantId, tenant_id: tenantId }, { $set: { state, updated_at: new Date() } }, { upsert: true });
}

// --- change streams -----------------------------------------------------------

export type TenantChangeEvent = {
  token: string; // opaque resume token (JSON) — hand back as resumeAfter
  coll: "attempts" | "revisions" | "agent_runs";
  op: string;
  doc: Attempt | Revision | AgentRun;
};

const WATCHED = ["attempts", "revisions", "agent_runs"] as const;

/** Live changes for one tenant only; the tenant filter is in the change-stream $match itself. */
export async function* watchTenant(tenantId: string, resumeAfter?: string, signal?: AbortSignal): AsyncGenerator<TenantChangeEvent> {
  assertDataTenant(tenantId);
  const db = (await getPlainClient()).db(env.mongoDb());
  const stream = db.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace"] },
          "ns.coll": { $in: [...WATCHED] },
          "fullDocument.tenant_id": tenantId,
        },
      },
    ],
    { fullDocument: "updateLookup", ...(resumeAfter ? { resumeAfter: JSON.parse(resumeAfter) as ResumeToken } : {}) },
  );
  const onAbort = () => void stream.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const change of stream) {
      if (!("fullDocument" in change) || !change.fullDocument) continue;
      const collName = change.ns.coll as TenantChangeEvent["coll"];
      const full = change.fullDocument as Document;
      const doc = collName === "attempts" ? publicAttempt(full) : collName === "revisions" ? publicRevision(full) : publicAgentRun(full);
      yield { token: JSON.stringify(change._id), coll: collName, op: change.operationType, doc };
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!stream.closed) await stream.close();
  }
}

// --- bulk deletes for seeding / demo reset ------------------------------------------

/** Remove every document of one tenant (never touches other tenants or global templates). */
export async function deleteTenantData(tenantId: string): Promise<Record<string, number>> {
  assertDataTenant(tenantId);
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const name of ["incidents", "attempts", "revisions", "agent_runs", "sim_state", "runbooks"]) {
    out[name] = (await db.collection(name).deleteMany({ tenant_id: tenantId })).deletedCount;
  }
  out.runbook_metrics = (await db.collection("runbook_metrics").deleteMany({ "meta.tenant_id": tenantId })).deletedCount;
  out.tenants = (await db.collection<SlugIdDoc>("tenants").deleteMany({ _id: tenantId, tenant_id: tenantId })).deletedCount;
  return out;
}

/** Demo reset: drop everything this tenant produced after `since` and roll runbooks back to v1 versions created before it. */
export async function rollbackTenantSince(tenantId: string, since: Date): Promise<Record<string, number>> {
  assertDataTenant(tenantId);
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const name of ["incidents", "attempts", "revisions", "agent_runs"]) {
    out[name] = (await db.collection(name).deleteMany({ tenant_id: tenantId, created_at: { $gt: since } })).deletedCount;
  }
  out.runbook_metrics = (await db.collection("runbook_metrics").deleteMany({ "meta.tenant_id": tenantId, timestamp: { $gt: since } })).deletedCount;
  const runbooks = db.collection("runbooks");
  const forkedAfter = await runbooks.deleteMany({ tenant_id: tenantId, created_at: { $gt: since } });
  out.runbooks_forks_removed = forkedAfter.deletedCount;
  const docs = await runbooks.find({ tenant_id: tenantId }).toArray();
  let rolled = 0;
  for (const rb of docs) {
    const keep = (rb.versions as { version: number; created_at: Date }[]).filter((v) => v.created_at <= since);
    if (keep.length !== rb.versions.length) {
      await runbooks.updateOne({ _id: rb._id, tenant_id: tenantId }, { $set: { versions: keep, current_version: Math.max(...keep.map((v) => v.version)) } });
      rolled++;
    }
    const [count] = await db.collection("attempts").aggregate(recountStatsPipeline(tenantId, rb._id)).toArray();
    const rolling = await rollingStats(tenantId, sid(rb._id));
    await runbooks.updateOne(
      { _id: rb._id, tenant_id: tenantId },
      { $set: { stats: { attempts: count?.attempts ?? 0, verified_successes: count?.verified_successes ?? 0, rolling_success_rate: rolling.rate } } },
    );
  }
  out.runbooks_rolled_back = rolled;
  return out;
}
