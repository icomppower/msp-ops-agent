// Idempotent Atlas setup: collections, $jsonSchema validators, regular indexes,
// Atlas Vector Search + Atlas Search indexes, time series collection, QE key
// vault + data encryption key. Safe to run repeatedly.
import "@/lib/env";
import { admin } from "@/db/tenantScoped";

const wait = process.argv.includes("--wait");

const report = await admin.ensureSchema();
console.log("== setup report ==");
console.log(JSON.stringify(report, null, 2));

if (wait) {
  console.log("waiting for search indexes to become queryable...");
  await admin.waitForSearchIndexes();
}

const health = await admin.health();
console.log("== health ==");
console.log(JSON.stringify(health, null, 2));

await admin.close();
