// The import rule is the mechanical guarantee behind "no raw Mongo client
// outside db/tenantScoped.ts".
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });
const CODE = `import { MongoClient } from "mongodb";\nexport const c = new MongoClient("x");\n`;

async function errorsFor(filePath: string) {
  const [res] = await eslint.lintText(CODE, { filePath });
  return res.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

describe("eslint no-restricted-imports", () => {
  it("flags a raw mongodb import in a route", async () => {
    expect((await errorsFor("app/api/x/route.ts")).length).toBe(1);
  });
  it("flags it in agent code and scripts too", async () => {
    expect((await errorsFor("agent/x.ts")).length).toBe(1);
    expect((await errorsFor("scripts/x.ts")).length).toBe(1);
  });
  it("allows it only in db/tenantScoped.ts", async () => {
    expect((await errorsFor("db/tenantScoped.ts")).length).toBe(0);
    expect((await errorsFor("db/other.ts")).length).toBe(1);
  });
});
