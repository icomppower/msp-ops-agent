// $jsonSchema validators for every collection. Pure data — no driver import here.
// Every tenant-data collection requires tenant_id; the time-series collection
// carries it in meta.tenant_id (the only place a time-series doc can hold it).

export const INCIDENT_TYPES = [
  "dns_misconfig",
  "expired_cert",
  "disk_full",
  "print_spooler",
  "vpn_mtu",
  "gpo_conflict",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

import { EMBEDDING_DIMS } from "@/lib/embedConfig";

const str = { bsonType: "string" } as const;
const date = { bsonType: "date" } as const;
const int = { bsonType: "int" } as const;
const bool = { bsonType: "bool" } as const;
const oid = { bsonType: "objectId" } as const;
const tenantId = { bsonType: "string", minLength: 1, description: "tenant slug; 'global' only on runbooks" } as const;

const stepSchema = {
  bsonType: "object",
  required: ["action"],
  properties: { action: str },
} as const;

export const validators: Record<string, object> = {
  tenants: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "tenant_id", "name", "environment", "created_at"],
      properties: {
        _id: str,
        tenant_id: tenantId,
        name: str,
        environment: {
          bsonType: "object",
          required: ["os_mix", "rmm", "edr", "network_gear", "quirks"],
          properties: {
            os_mix: { bsonType: "array", items: str },
            rmm: str,
            edr: str,
            network_gear: { bsonType: "array", items: str },
            quirks: { bsonType: "array", items: str },
          },
        },
        created_at: date,
      },
    },
  },

  // env_snapshot.credentials / env_snapshot.ips are Queryable-Encryption fields;
  // the server validates those itself, so this schema deliberately does not
  // describe them (a $jsonSchema that names an encrypted path is rejected).
  incidents: {
    $jsonSchema: {
      bsonType: "object",
      required: ["tenant_id", "type", "title", "symptoms", "env_snapshot", "embedding", "status", "created_at"],
      properties: {
        tenant_id: tenantId,
        type: { enum: [...INCIDENT_TYPES] },
        title: str,
        symptoms: { bsonType: "array", minItems: 1, items: str },
        env_snapshot: { bsonType: "object" },
        embedding: { bsonType: "array", minItems: EMBEDDING_DIMS, maxItems: EMBEDDING_DIMS, items: { bsonType: "number" } },
        status: { enum: ["open", "resolved", "failed"] },
        created_at: date,
      },
    },
  },

  runbooks: {
    $jsonSchema: {
      bsonType: "object",
      required: ["tenant_id", "name", "incident_type", "current_version", "versions", "stats", "created_at"],
      properties: {
        tenant_id: tenantId,
        name: str,
        incident_type: { enum: [...INCIDENT_TYPES] },
        current_version: { bsonType: "int", minimum: 1 },
        forked_from: oid,
        versions: {
          bsonType: "array",
          minItems: 1,
          items: {
            bsonType: "object",
            required: ["version", "steps", "created_at", "reason"],
            properties: {
              version: { bsonType: "int", minimum: 1 },
              steps: { bsonType: "array", minItems: 1, items: stepSchema },
              created_at: date,
              reason: str,
            },
          },
        },
        stats: {
          bsonType: "object",
          required: ["attempts", "verified_successes", "rolling_success_rate"],
          properties: {
            attempts: { bsonType: "int", minimum: 0 },
            verified_successes: { bsonType: "int", minimum: 0 },
            rolling_success_rate: { bsonType: "number", minimum: 0, maximum: 1 },
          },
        },
        created_at: date,
      },
    },
  },

  attempts: {
    $jsonSchema: {
      bsonType: "object",
      required: ["tenant_id", "incident_id", "runbook_id", "runbook_version", "steps_executed", "verification", "phase", "created_at"],
      properties: {
        tenant_id: tenantId,
        incident_id: oid,
        runbook_id: oid,
        runbook_version: { bsonType: "int", minimum: 1 },
        steps_executed: {
          bsonType: "array",
          items: { bsonType: "object", required: ["step", "ok", "detail"], properties: { step: stepSchema, ok: bool, detail: str } },
        },
        verification: {
          bsonType: "object",
          required: ["passed", "check_name", "detail"],
          properties: { passed: bool, check_name: str, detail: str },
        },
        phase: { enum: ["seed", "live", "replay"] },
        created_at: date,
      },
    },
  },

  revisions: {
    $jsonSchema: {
      bsonType: "object",
      required: ["tenant_id", "runbook_id", "from_version", "to_version", "trigger", "diff", "rationale", "created_at"],
      properties: {
        tenant_id: tenantId,
        runbook_id: oid,
        from_version: int,
        to_version: int,
        trigger: {
          bsonType: "object",
          required: ["failed_attempt_ids", "success_rate", "window"],
          properties: {
            failed_attempt_ids: { bsonType: "array", items: oid },
            success_rate: { bsonType: "number" },
            window: int,
          },
        },
        diff: {
          bsonType: "object",
          required: ["added", "removed", "summary"],
          properties: { added: { bsonType: "array", items: stepSchema }, removed: { bsonType: "array", items: stepSchema }, summary: str },
        },
        rationale: str,
        created_at: date,
      },
    },
  },

  // The agent's working memory for one incident (status per loop step).
  agent_runs: {
    $jsonSchema: {
      bsonType: "object",
      required: ["tenant_id", "incident_id", "status", "steps", "created_at", "updated_at"],
      properties: {
        tenant_id: tenantId,
        incident_id: oid,
        status: { enum: ["running", "passed", "failed", "revised", "error"] },
        steps: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["name", "status", "at"],
            properties: { name: str, status: { enum: ["pending", "running", "done", "failed"] }, detail: str, at: date },
          },
        },
        chosen_runbook_id: oid,
        runbook_version: int,
        created_at: date,
        updated_at: date,
      },
    },
  },

  // Simulated tenant environment state — lives here, not in process memory.
  sim_state: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "tenant_id", "state", "updated_at"],
      properties: { _id: str, tenant_id: tenantId, state: { bsonType: "object" }, updated_at: date },
    },
  },

  runbook_metrics: {
    $jsonSchema: {
      bsonType: "object",
      required: ["timestamp", "meta", "passed", "rolling_success_rate", "runbook_version"],
      properties: {
        timestamp: date,
        meta: { bsonType: "object", required: ["tenant_id", "runbook_id"], properties: { tenant_id: tenantId, runbook_id: oid } },
        passed: bool,
        rolling_success_rate: { bsonType: "number", minimum: 0, maximum: 1 },
        runbook_version: int,
      },
    },
  },
};

export const TIME_SERIES = {
  runbook_metrics: { timeField: "timestamp", metaField: "meta", granularity: "minutes" as const },
};

export const KEY_VAULT_COLLECTION = "__keyVault";

// Fields protected with Queryable Encryption (unindexed: stored encrypted, never
// queried). QE requires a distinct data encryption key per field.
export const ENCRYPTED_FIELD_PATHS = ["env_snapshot.credentials", "env_snapshot.ips"] as const;
export type EncryptedFieldPath = (typeof ENCRYPTED_FIELD_PATHS)[number];
export const dekAltName = (path: EncryptedFieldPath) => `msp_ops_${path.replace(/\./g, "_")}`;

export const SEARCH_INDEXES = {
  vector: {
    name: "incidents_vector",
    type: "vectorSearch" as const,
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMS, similarity: "cosine" },
        { type: "filter", path: "tenant_id" },
      ],
    },
  },
  text: {
    name: "incidents_text",
    type: "search" as const,
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title: { type: "string" },
          symptoms: { type: "string" },
          tenant_id: { type: "token" },
        },
      },
    },
  },
};

export const REGULAR_INDEXES: Record<string, { keys: Record<string, 1 | -1>; options?: { unique?: boolean; name?: string } }[]> = {
  incidents: [{ keys: { tenant_id: 1, created_at: -1 } }, { keys: { tenant_id: 1, type: 1, created_at: -1 } }],
  attempts: [{ keys: { tenant_id: 1, created_at: -1 } }, { keys: { tenant_id: 1, runbook_id: 1, created_at: -1 } }, { keys: { tenant_id: 1, incident_id: 1 } }],
  revisions: [{ keys: { tenant_id: 1, created_at: -1 } }, { keys: { tenant_id: 1, runbook_id: 1 } }],
  agent_runs: [{ keys: { tenant_id: 1, created_at: -1 } }, { keys: { tenant_id: 1, incident_id: 1 } }],
  runbooks: [{ keys: { tenant_id: 1, incident_type: 1 } }],
};
