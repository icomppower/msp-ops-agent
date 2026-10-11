import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Tenant isolation is enforced here, not in prompts: only db/tenantScoped.ts may
// touch the raw driver. Everything else goes through its tenantId-first exports.
const RAW_DRIVER_RULE = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "mongodb", message: "Raw Mongo client is only allowed in db/tenantScoped.ts. Use its tenant-scoped exports." },
        { name: "mongodb-client-encryption", message: "Encryption helpers live in db/tenantScoped.ts." },
      ],
      patterns: [{ group: ["mongodb/*"], message: "Raw Mongo client is only allowed in db/tenantScoped.ts." }],
    },
  ],
};

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    rules: { ...RAW_DRIVER_RULE, "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    files: ["db/tenantScoped.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
